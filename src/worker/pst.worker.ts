import * as Comlink from 'comlink'
import MiniSearch from 'minisearch'
import { queryTerms } from '../lib/highlight'
import { parseTnef, type TnefAttachment } from '../lib/tnef'
import { extractSmime } from '../lib/smime'
import {
  createMsgFolder,
  msgAppointmentCard,
  msgContactCard,
  msgFieldsOf,
  parseMsg,
} from './msg'
import { isCfbFile, parseEml } from './eml'
import { salvageOpenPst } from './salvage'
import { makeChunkedReader, type ChunkedReader } from './chunkReader'
import { fingerprintOf, getCachedIndex, putCachedIndex } from './indexCache'
import {
  Consts,
  openPst,
  PSTAppointment,
  PSTContact,
  PSTTask,
  type IPSTAppointment,
  type IPSTAttachment,
  type IPSTContact,
  type IPSTFile,
  type IPSTFolder,
  type IPSTMessage,
  type IPSTTask,
} from '@hiraokahypertools/pst-extractor'
import type {
  AppointmentCard,
  AttachmentData,
  AttachmentMeta,
  ContactCard,
  DistListCard,
  ContactMatch,
  EmbeddedMessageResult,
  FolderMessages,
  FolderNode,
  InlineImage,
  JournalCard,
  MessageContent,
  MessageMeta,
  OcrMatchResult,
  OcrTarget,
  RecipientInfo,
  SearchHit,
  SourceIndex,
  TaskCard,
} from '../types'

/**
 * Off-thread PST parsing.
 *
 * Strategy: index-first, lazy bodies.
 *  - openSource() walks the folder tree only (fast) and keeps the live
 *    PST objects in a worker-side registry.
 *  - getFolderMessages() loads a single folder's message metadata on demand.
 *  - Full bodies + attachments are fetched per-message in later phases.
 */

interface SourceEntry {
  file: IPSTFile
  /** The caching reader under `file`, so its slabs can be handed back when
   *  memory is short. Absent for sources opened by salvage recovery. */
  reader?: ChunkedReader
  folders: Map<string, IPSTFolder>
  messages: Map<string, IPSTMessage>
  /** Cached attachment handles per message id, for lazy byte fetching. */
  attachments: Map<string, IPSTAttachment[]>
  /** OCR text per image, keyed `${kind}:${messageId}:${ref}` (for locating matches). */
  ocr: Map<string, string>
  /** Count of data: images in each message body (only messages that have any). */
  bodyImageCount: Map<string, number>
  /** Indexes of image attachments per message, for the OCR pass. Kept instead
   *  of the attachment handles, which would retain their messages. */
  imageAttachments: Map<string, number[]>
  /** Search-index document ids contributed by this source (for cleanup). */
  searchIds: Set<string>
  /** Attachments recovered from a winmail.dat (TNEF), keyed by message id. */
  tnef: Map<string, TnefAttachment[]>
  /** For .msg sources: files that failed to parse, counted per folder. */
  extraUnreadable?: Map<string, number>
  /** File identity for the on-device search-index cache (PST/OST only). */
  fingerprint?: string
  /** The label shown in the sidebar, for the mailbox: search filter. */
  label?: string
  /** Cached search docs found for this file, consumed by indexSource. */
  cachedDocs?: SearchDoc[] | null
  /** Did the indexing pass cover the whole mailbox? Only a complete pass is
   *  worth storing: caching a partial one would hide the missing mail from
   *  search on every future open. */
  indexComplete?: boolean
  /** People seen in this source (key: lowercased label), for suggestions. */
  people?: Map<string, { label: string; count: number }>
  /** Memoised per-folder message lists (see folderEmails). */
  emailLists: Map<string, IPSTMessage[]>
  /** Folder display names by id, for the folder: search filter. */
  folderNames: Map<string, string>
}

const sources = new Map<string, SourceEntry>()

interface SearchDoc {
  id: string
  sourceId: string
  messageId: string
  folderId: string
  subject: string
  from: string
  to: string
  body: string
  attachments: string
  ocr: string
  date: number | null
  hasAttachments: boolean
  importance: 'high' | 'low' | null
  flagged: boolean
  unread: boolean
}

const searchIndex = new MiniSearch<SearchDoc>({
  idField: 'id',
  fields: ['subject', 'from', 'to', 'body', 'attachments', 'ocr'],
  storeFields: ['sourceId', 'messageId', 'folderId', 'subject', 'from', 'date', 'hasAttachments'],
  searchOptions: { boost: { subject: 3, from: 2 }, fuzzy: 0.2, prefix: true },
})

/** Keep the indexed docs so OCR text can be merged in later (replace). */
const searchDocs = new Map<string, SearchDoc>()

/** Tiny always-in-memory copy of every doc's filterable fields (no bodies),
 *  so field filters and filter-only queries work after docs are released. */
interface MetaDoc {
  id: string
  sourceId: string
  messageId: string
  folderId: string
  subject: string
  from: string
  to: string
  date: number | null
  hasAttachments: boolean
  importance: 'high' | 'low' | null
  flagged: boolean
  unread: boolean
}
const metaDocs = new Map<string, MetaDoc>()

function metaOf(d: SearchDoc): MetaDoc {
  return {
    id: d.id,
    sourceId: d.sourceId,
    messageId: d.messageId,
    folderId: d.folderId,
    subject: d.subject,
    from: d.from,
    to: d.to,
    date: d.date,
    hasAttachments: d.hasAttachments,
    importance: d.importance ?? null,
    flagged: d.flagged ?? false,
    unread: d.unread ?? false,
  }
}

const IMAGE_EXT = /\.(png|jpe?g|gif|bmp|webp|tiff?)$/i
function isImageAttachment(name: string, mime: string): boolean {
  return mime.toLowerCase().startsWith('image/') || IMAGE_EXT.test(name)
}

// Images embedded straight into the HTML body as base64 (not PST attachments).
const DATA_IMG_RE = /<img\b[^>]*?\ssrc\s*=\s*(["'])(data:image\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=\s]+?)\1/gi

/** The data: image URLs in a body, in document order (matches the rendered DOM). */
function dataImageUrls(html: string): string[] {
  if (!html) return []
  const out: string[] = []
  DATA_IMG_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = DATA_IMG_RE.exec(html))) out.push(m[2].replace(/\s+/g, ''))
  return out
}

/** Decode a `data:image/...;base64,...` URL into bytes + mime. */
function dataUrlToBytes(dataUrl: string): { mime: string; data: ArrayBuffer } | null {
  const comma = dataUrl.indexOf(',')
  if (comma < 0) return null
  const mime = dataUrl.slice(5, comma).split(';')[0] || 'image/png'
  try {
    const bin = atob(dataUrl.slice(comma + 1))
    const bytes = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
    return { mime, data: bytes.buffer }
  } catch {
    return null
  }
}

function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#3[49];/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
}

/** Enumerate a folder's messages once and reuse the list: the message list
 *  and the background indexer both ask for the same folders, and each
 *  enumeration re-reads the folder's tables from the file. */
async function folderEmails(entry: SourceEntry, folderId: string): Promise<IPSTMessage[]> {
  const cached = entry.emailLists.get(folderId)
  if (cached) return cached
  const folder = entry.folders.get(folderId)
  if (!folder) return []
  const emails = await folder.getEmails()
  for (const m of emails) safe(() => entry.messages.set(String(m.primaryNodeId), m), undefined)
  entry.emailLists.set(folderId, emails)
  return emails
}

/**
 * Read one folder's messages, treating failure as a memory problem first.
 *
 * The read that fails on a machine short of memory is usually the one that
 * asked for the last allocation, not a damaged folder, and retrying straight
 * away just asks again under the same conditions. So each further attempt
 * first hands back this file's cached slabs — pure cache, worth far more as
 * free memory than as a read cache while things are tight — and waits a
 * little, giving the browser room to collect and other tabs room to release.
 *
 * Returns null only when the folder could not be read at all, which means
 * every message in it is missing from the index.
 */
async function readFolderUnderPressure(
  entry: SourceEntry,
  folderId: string,
): Promise<IPSTMessage[] | null> {
  const backoffMs = [0, 250, 1000]
  for (let attempt = 0; attempt < backoffMs.length; attempt++) {
    if (attempt > 0) {
      entry.reader?.trim()
      await new Promise((resolve) => setTimeout(resolve, backoffMs[attempt]))
    }
    try {
      return await folderEmails(entry, folderId)
    } catch {
      // Try again, with more room than last time.
    }
  }
  return null
}

/**
 * Does an indexed document count plausibly cover a mailbox of this size?
 *
 * A folder's contentCount is exact in practice, so a walk that reads every
 * folder lands on the declared total; the margin only absorbs a list that
 * comes back short. Wholesale absence means the pass lost folders and must
 * not be treated as a finished index.
 */
function coversMailbox(indexed: number, declared: number): boolean {
  return declared === 0 || indexed >= declared * 0.9
}

function safe<T>(fn: () => T, fallback: T): T {
  try {
    return fn()
  } catch {
    return fallback
  }
}

async function safeAsync<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await fn()
  } catch {
    return fallback
  }
}

function toMeta(m: IPSTMessage, folderId: string): MessageMeta {
  const delivery = safe(() => m.messageDeliveryTime, null)
  const submit = safe(() => m.clientSubmitTime, null)
  const date = (delivery ?? submit)?.getTime() ?? null
  return {
    id: String(m.primaryNodeId),
    folderId,
    subject: safe(() => m.subject, '') || '(no subject)',
    fromName: safe(() => m.senderName, '') || safe(() => m.sentRepresentingName, ''),
    fromEmail:
      safe(() => m.senderEmailAddress, '') || safe(() => m.sentRepresentingEmailAddress, ''),
    to: safe(() => m.displayTo, ''),
    date,
    hasAttachments: safe(() => m.hasAttachments, false),
    isRead: safe(() => m.isRead, true),
    messageClass: safe(() => m.messageClass, ''),
  }
}

// Outlook marks its internal/system folders (Sync Issues, Conversation Action
// Settings, etc.) with PR_ATTR_HIDDEN. Skipping hidden folders drops them from
// the tree regardless of their (possibly localized) display names.
function isHiddenFolder(folder: IPSTFolder): boolean {
  const v = safe(() => folder.getProperty(0x10f4)?.value, false)
  return v === true || v === 1
}

async function buildFolderTree(folder: IPSTFolder, entry: SourceEntry): Promise<FolderNode> {
  const id = String(folder.primaryNodeId)
  entry.folders.set(id, folder)
  entry.folderNames.set(id, safe(() => folder.displayName, '') || '')
  const subs = await safeAsync(() => folder.getSubFolders(), [] as IPSTFolder[])
  const children: FolderNode[] = []
  for (const sub of subs) {
    if (isHiddenFolder(sub)) continue
    children.push(await buildFolderTree(sub, entry))
  }
  return {
    id,
    name: safe(() => folder.displayName, '') || '(unnamed folder)',
    containerClass: safe(() => folder.containerClass, ''),
    messageCount: safe(() => folder.contentCount, 0),
    children,
  }
}

/**
 * Pick the folder subtree that represents the user's mailbox.
 *
 * A .pst keeps everything under one "Top of Personal Folders" container, and
 * the library's getTopOfOutlookDataFile finds it by a fixed node id. An .ost
 * breaks both assumptions: the mail lives under a store root ("Root -
 * Mailbox" -> "IPM_SUBTREE") next to internal plumbing (Common Views, Finder,
 * ~MAPISP(Internal), ...), there can be several IPM_SUBTREEs (an empty
 * public-folders one often enumerates first), and the fixed node id can land
 * on an arbitrary mail folder instead.
 *
 * So: choose by evidence, not by name. Candidates are the library's answer,
 * every folder named IPM_SUBTREE, and the root itself; the winner is the one
 * whose subtree holds the most messages (ties: deepest, then most folders).
 * Siblings of the winner that also hold mail (e.g. Exchange's Recoverable
 * Items) are kept as extra top-level folders; empty plumbing is dropped.
 */
interface Scored {
  node: FolderNode
  parent: FolderNode | null
  depth: number
  messages: number
  folders: number
}

function scoreTree(root: FolderNode): Map<FolderNode, Scored> {
  const scores = new Map<FolderNode, Scored>()
  const walk = (node: FolderNode, parent: FolderNode | null, depth: number): Scored => {
    let messages = node.messageCount
    let folders = node.children.length
    for (const child of node.children) {
      const s = walk(child, node, depth + 1)
      messages += s.messages
      folders += s.folders
    }
    const scored: Scored = { node, parent, depth, messages, folders }
    scores.set(node, scored)
    return scored
  }
  walk(root, null, 0)
  return scores
}

export function selectMailboxTree(
  root: FolderNode,
  libraryTopId: string | null,
): { tree: FolderNode; ownerHint: string } {
  const scores = scoreTree(root)
  const candidates: Scored[] = []
  for (const s of scores.values()) {
    if (s.node === root || s.node.name === 'IPM_SUBTREE' || s.node.id === libraryTopId) {
      candidates.push(s)
    }
  }
  candidates.sort(
    (a, b) => b.messages - a.messages || b.depth - a.depth || b.folders - a.folders,
  )
  // The root always contains at least as much mail as anything inside it, so
  // it can only ever be the fallback: judging it as a candidate would mean
  // showing the raw tree (store root, IPM_SUBTREE, Common Views, Finder, ...)
  // the moment a single message lived outside the chosen container.
  const best = candidates.find((c) => c.node !== root)
  if (!best || best.messages === 0) return { tree: root, ownerHint: '' }

  // Rescue sibling subtrees that hold mail (dropping the empty plumbing).
  const extras = (best.parent?.children ?? [])
    .filter((sib) => sib !== best.node && (scores.get(sib)?.messages ?? 0) > 0)

  // Only prune when the result still accounts for every message. If mail lives
  // somewhere this view would not reach, show the whole tree instead: a tidier
  // tree is never worth hiding messages in a mailbox someone is reviewing.
  const covered =
    best.messages + extras.reduce((n, sib) => n + (scores.get(sib)?.messages ?? 0), 0)
  if (covered < (scores.get(root)?.messages ?? 0)) return { tree: root, ownerHint: '' }

  return {
    tree: { ...root, children: [...best.node.children, ...extras] },
    // The chosen container (or its parent store root) sometimes carries the
    // mailbox owner's name; generic names are filtered by the caller.
    ownerHint: best.node.name || best.parent?.name || '',
  }
}

/** Drop worker-side folder handles that are not part of the displayed tree, so
 *  indexing (which enumerates the handle map) matches what the user can open. */
function pruneFolderHandles(entry: SourceEntry, rootNode: FolderNode): void {
  const keep = new Set<string>()
  const walk = (n: FolderNode) => {
    keep.add(n.id)
    n.children.forEach(walk)
  }
  walk(rootNode)
  for (const id of entry.folders.keys()) {
    if (!keep.has(id)) entry.folders.delete(id)
  }
}

async function buildSearchDoc(
  sourceId: string,
  folderId: string,
  msgId: string,
  m: IPSTMessage,
  entry: SourceEntry,
): Promise<SearchDoc> {
  const bodies = extractBodies(m)
  const html = bodies.html
  const body = bodies.text || (html ? stripHtml(html) : '')

  const bodyImgCount = html ? dataImageUrls(html).length : 0
  if (bodyImgCount) entry.bodyImageCount.set(msgId, bodyImgCount)

  let attachments = ''
  if (safe(() => m.hasAttachments, false)) {
    const list = await safeAsync(() => m.getAttachments(), [])
    entry.attachments.set(msgId, list) // warm cache for later preview
    // Note which attachments are images while we have them in hand. The OCR
    // pass needs to know they exist, and remembering two numbers per image is
    // cheaper than holding a handle that keeps its whole message alive.
    const images = list
      .map((a, index) =>
        safe(() => a.attachMethod, 0) === Consts.ATTACH_BY_VALUE &&
        isImageAttachment(attachmentName(a, index, false), safe(() => a.mimeTag, ''))
          ? index
          : -1,
      )
      .filter((index) => index >= 0)
    if (images.length) entry.imageAttachments.set(msgId, images)
    attachments = list
      .map((a) => safe(() => a.longFilename, '') || safe(() => a.filename, ''))
      .filter(Boolean)
      .join(' ')
  }

  const delivery = safe(() => m.messageDeliveryTime, null)
  const submit = safe(() => m.clientSubmitTime, null)

  // displayTo/CC usually carry names only; add recipient addresses so
  // to:/person: filters match either form.
  const recipients = await safeAsync(() => m.getRecipients(), [])
  const recipientAddresses = recipients
    .map((r) => safe(() => r.smtpAddress, '') || safe(() => r.emailAddress, ''))
    .filter(Boolean)
    .join(' ')

  // Collect the people involved for search autocompletion.
  entry.people ??= new Map()
  const addPerson = (name: string, email: string) => {
    const nm = cleanStr(name)
    const em = (email || '').trim()
    const label = nm && em.includes('@') ? `${nm} <${em}>` : nm || (em.includes('@') ? em : '')
    if (!label) return
    const key = label.toLowerCase()
    const p = entry.people!.get(key)
    if (p) p.count++
    else entry.people!.set(key, { label, count: 1 })
  }
  addPerson(
    safe(() => m.senderName, ''),
    safe(() => m.senderEmailAddress, ''),
  )
  for (const r of recipients) {
    addPerson(
      safe(() => r.displayName, ''),
      safe(() => r.smtpAddress, '') || safe(() => r.emailAddress, ''),
    )
  }

  return {
    id: `${sourceId}:${msgId}`,
    sourceId,
    messageId: msgId,
    folderId,
    subject: safe(() => m.subject, ''),
    from: `${safe(() => m.senderName, '')} ${safe(() => m.senderEmailAddress, '')}`.trim(),
    to: `${safe(() => m.displayTo, '')} ${safe(() => m.displayCC, '')} ${recipientAddresses}`.trim(),
    body,
    attachments,
    ocr: '',
    date: (delivery ?? submit)?.getTime() ?? null,
    hasAttachments: safe(() => m.hasAttachments, false),
    importance: (() => {
      const v = safe(() => m.importance, 1)
      return v === 2 ? ('high' as const) : v === 0 ? ('low' as const) : null
    })(),
    flagged: safe(() => m.getProperty(0x1090)?.value, 0) === 2,
    unread: !safe(() => m.isRead, true),
  }
}

const stripExt = (name: string) => name.replace(/\.[^.]+$/, '')

// Default names Outlook gives every personal data file: not a useful mailbox
// label, so we prefer the user's filename when the store reports one of these.
function isGenericStoreName(name: string): boolean {
  const n = (name || '').trim().toLowerCase()
  return (
    n === '' ||
    /^(top of )?(personal folders|outlook data file)\b/.test(n) ||
    n === 'mailbox' ||
    n === 'root' ||
    n === 'root - mailbox' ||
    n === 'root - public' ||
    n === 'ipm_subtree'
  )
}

/** A tidy label from a filename: drop the extension, underscores to spaces, title-case. */
function prettyFileName(fileName: string): string {
  const base = stripExt(fileName)
    .replace(/_+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return base ? base.replace(/\b[a-z]/g, (ch) => ch.toUpperCase()) : 'Mailbox'
}

const IMAGE_MIME_BY_EXT: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  bmp: 'image/bmp',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  tif: 'image/tiff',
  tiff: 'image/tiff',
  ico: 'image/x-icon',
}

function guessMimeFromName(name: string): string {
  const ext = name.split('.').pop()?.toLowerCase() ?? ''
  return IMAGE_MIME_BY_EXT[ext] ?? ''
}

function cleanCid(cid: string): string {
  return cid.replace(/^<+|>+$/g, '').trim()
}

// MAPI body property tags.
const PR_BODY = 0x1000 // plain text
const PR_HTML = 0x1013 // HTML (often stored as PT_BINARY)
const PR_INTERNET_CPID = 0x3fde // code page of the body bytes

function codepageToLabel(cp?: number): string {
  switch (cp) {
    case 65001:
    case 20127:
      return 'utf-8'
    case 1250:
    case 1251:
    case 1252:
    case 1253:
    case 1254:
    case 1255:
    case 1256:
    case 1257:
    case 1258:
      return `windows-${cp}`
    case 932:
      return 'shift_jis'
    case 936:
      return 'gbk'
    case 949:
      return 'euc-kr'
    case 950:
      return 'big5'
    case 866:
      return 'ibm866'
    case 28591:
    case 28592:
    case 28595:
    case 28596:
    case 28597:
    case 28598:
    case 28599:
    case 28603:
    case 28605:
      return `iso-8859-${cp - 28590}`
    case 50220:
    case 50221:
    case 50222:
      return 'iso-2022-jp'
    case 51932:
      return 'euc-jp'
    case 874:
      return 'windows-874'
    case 10000:
      return 'macintosh'
    case 20866:
      return 'koi8-r'
    case 21866:
      return 'koi8-u'
    default:
      // An unknown code page is far more likely to be some 8-bit encoding than
      // UTF-8, and windows-1252 at least keeps the ASCII half readable.
      return cp && cp !== 1200 ? 'windows-1252' : 'utf-8'
  }
}

function decodeBinary(buf: ArrayBuffer, cp?: number): string {
  const bytes = new Uint8Array(buf)
  try {
    return new TextDecoder(codepageToLabel(cp), { fatal: false }).decode(bytes)
  } catch {
    return new TextDecoder('utf-8', { fatal: false }).decode(bytes)
  }
}

/** PidTagMessageCodepage: the code page of the message's own 8-bit strings. */
const PR_MESSAGE_CODEPAGE = 0x3ffd

/**
 * Which code page a body is written in.
 *
 * The HTML body is tagged by the internet code page, but a plain-text body is
 * in the message's own one, and the two can differ: a message received as
 * iso-2022-jp carries its text as Shift-JIS. Reading text with the transport
 * code page turns those bodies into nonsense, so each is asked for its own,
 * falling back to the other when only one is set.
 */
function bodyCodepage(m: IPSTMessage, forText = false): number | undefined {
  const read = (tag: number) => {
    const v = safe(() => m.getProperty(tag)?.value, undefined)
    return typeof v === 'number' && v > 0 ? v : undefined
  }
  const internet = read(PR_INTERNET_CPID)
  const message = read(PR_MESSAGE_CODEPAGE)
  return forText ? (message ?? internet) : (internet ?? message)
}

function propString(m: IPSTMessage, key: number, forText = false): string {
  const value = safe(() => m.getProperty(key)?.value, undefined)
  if (typeof value === 'string') return value
  if (value instanceof ArrayBuffer && value.byteLength > 0) {
    return decodeBinary(value, bodyCodepage(m, forText))
  }
  return ''
}

const CONTROL_WORD = /^\\([a-zA-Z]+)(-?\d+)? ?/

/**
 * De-encapsulate Outlook compressed-RTF (already decompressed via `bodyRTF`).
 * Recovers the original HTML for `\fromhtml` mail (MS-OXRTFEX), or best-effort
 * text for `\fromtext` / plain RTF.
 */
export function deEncapsulateRtf(rtf: string, cp?: number): { html: string; text: string } {
  if (!rtf || rtf.indexOf('\\rtf') === -1) return { html: '', text: '' }
  const isHtml = /\\fromhtml1?\b/.test(rtf) || rtf.indexOf('\\*\\htmltag') !== -1

  interface GState {
    htmlrtf: boolean
    suppress: boolean
    htmltag: boolean
    ucSkip: number
  }
  let st: GState = { htmlrtf: false, suppress: false, htmltag: false, ucSkip: 1 }
  const stack: GState[] = []
  const out: string[] = []
  let hex: number[] = []
  let pendingStar = false
  let skipChars = 0
  const n = rtf.length
  let i = 0
  // The RTF's own \ansicpgN header names the code page of its \'xx bytes; it
  // beats the caller's hint (PR_INTERNET_CPID can be a transport-only encoding
  // like iso-2022-jp while the RTF text is really e.g. cp932).
  let hexCp = cp

  const flushHex = () => {
    if (!hex.length) return
    if (st.htmltag || (!st.htmlrtf && !st.suppress)) {
      try {
        out.push(new TextDecoder(codepageToLabel(hexCp), { fatal: false }).decode(new Uint8Array(hex)))
      } catch {
        out.push(new TextDecoder('utf-8', { fatal: false }).decode(new Uint8Array(hex)))
      }
    }
    hex = []
  }
  const emit = (s: string) => {
    if (st.htmltag || (!st.htmlrtf && !st.suppress)) out.push(s)
  }

  while (i < n) {
    const c = rtf[i]
    // A \uN character is followed by an ANSI fallback for old readers, which
    // must be skipped. The fallback is usually a \'xx escape, so skipping has
    // to consume whole escapes, not raw characters: counting characters both
    // emits the fallback a second time and then eats the character after it.
    if (skipChars > 0) {
      if (c === '{' || c === '}') {
        skipChars = 0 // a group boundary ends the fallback
      } else if (c === '\\') {
        const d = rtf[i + 1]
        if (d === "'") {
          i += 4 // \'xx
          skipChars--
          continue
        }
        if (d && /[a-zA-Z]/.test(d)) {
          let j = i + 1
          while (j < n && /[a-zA-Z]/.test(rtf[j])) j++
          while (j < n && /[-0-9]/.test(rtf[j])) j++
          if (rtf[j] === ' ') j++
          i = j
          skipChars--
          continue
        }
        if (d === '\\' || d === '{' || d === '}') {
          i += 2
          skipChars--
          continue
        }
        skipChars = 0 // lone backslash: stop skipping rather than guess
      } else {
        skipChars--
        i++
        continue
      }
    }
    if (c === '{') {
      flushHex()
      stack.push(st)
      st = { ...st, htmltag: false }
      i++
      continue
    }
    if (c === '}') {
      flushHex()
      st = stack.pop() ?? st
      i++
      continue
    }
    if (c === '\\') {
      const d = rtf[i + 1]
      if (d === '\\' || d === '{' || d === '}') {
        flushHex()
        emit(d)
        i += 2
        continue
      }
      if (d === "'") {
        const b = parseInt(rtf.substr(i + 2, 2), 16)
        if (!Number.isNaN(b)) hex.push(b)
        i += 4
        continue
      }
      if (d === '*') {
        flushHex()
        pendingStar = true
        i += 2
        continue
      }
      flushHex()
      const m2 = CONTROL_WORD.exec(rtf.slice(i))
      if (!m2) {
        i++
        continue
      }
      const word = m2[1]
      const param = m2[2] !== undefined ? parseInt(m2[2], 10) : undefined
      i += m2[0].length

      if (pendingStar) {
        pendingStar = false
        if (word === 'htmltag' || word === 'mhtmltag') st = { ...st, htmltag: true }
        else st = { ...st, suppress: true }
        continue
      }

      switch (word) {
        // Destination groups whose content is not document text (the font and
        // color tables leak as literal "Arial;Times;..." text otherwise).
        case 'fonttbl':
        case 'colortbl':
        case 'stylesheet':
        case 'info':
        case 'listtable':
        case 'listoverridetable':
        case 'pict':
        case 'themedata':
        case 'colorschememapping':
        case 'generator':
          st = { ...st, suppress: true }
          break
        case 'htmlrtf':
          st = { ...st, htmlrtf: param !== 0 }
          break
        case 'ansicpg':
          if (param) hexCp = param
          break
        case 'uc':
          st = { ...st, ucSkip: param ?? 1 }
          break
        case 'u':
          if (param !== undefined) {
            emit(String.fromCharCode(param < 0 ? param + 65536 : param))
            skipChars = st.ucSkip
          }
          break
        case 'par':
        case 'line':
          if (!isHtml) emit('\n')
          break
        case 'tab':
          if (!isHtml) emit('\t')
          break
        case 'lquote': emit('‘'); break
        case 'rquote': emit('’'); break
        case 'ldblquote': emit('“'); break
        case 'rdblquote': emit('”'); break
        case 'bullet': emit('•'); break
        case 'endash': emit('–'); break
        case 'emdash': emit('—'); break
        case 'nbsp': emit(' '); break
        default:
          break
      }
      continue
    }
    if (c === '\r' || c === '\n') {
      i++
      continue
    }
    flushHex()
    emit(c)
    i++
  }
  flushHex()

  const result = out.join('')
  return isHtml ? { html: result.trim() ? result : '', text: '' } : { html: '', text: result }
}

/** Extract the best HTML + text body, covering bodyHTML, PR_HTML binary, and RTF. */
function extractBodies(m: IPSTMessage): { html: string; text: string } {
  let html = safe(() => m.bodyHTML, '') || propString(m, PR_HTML)
  let text = safe(() => m.body, '') || propString(m, PR_BODY, true)
  if (!html) {
    const rtf = safe(() => m.bodyRTF, '')
    if (rtf) {
      const de = deEncapsulateRtf(rtf, bodyCodepage(m))
      if (de.html) html = de.html
      else if (!text && de.text) text = de.text
    }
  }
  return { html, text }
}

function attachmentName(a: IPSTAttachment, index: number, isEmbedded: boolean): string {
  return (
    safe(() => a.longFilename, '') ||
    safe(() => a.filename, '') ||
    (isEmbedded ? safe(() => a.displayName, '') || 'Embedded message' : `attachment-${index + 1}`)
  )
}

/** Build the full, serializable content of a message (shared by top-level and embedded). */
/** Map a PST message class to the item kind we render. */
function itemKindOf(messageClass: string): MessageContent['itemKind'] {
  const c = (messageClass || '').toLowerCase()
  if (c.startsWith('ipm.distlist')) return 'distlist'
  if (c.startsWith('ipm.task')) return 'task'
  if (c.startsWith('ipm.activity')) return 'journal'
  if (c.startsWith('ipm.stickynote')) return 'note'
  if (c.startsWith('ipm.contact')) return 'contact'
  if (c.startsWith('ipm.appointment') || c.startsWith('ipm.schedule.meeting')) return 'appointment'
  return 'email'
}

// Re-wrap a message as a typed contact/appointment, reusing its internals so all
// getters (including named MAPI properties like email/address) resolve.
function asContact(m: IPSTMessage): IPSTContact {
  const x = m as unknown as Record<string, unknown>
  return new (PSTContact as unknown as new (...a: unknown[]) => IPSTContact)(
    x._rootProvider,
    x._node,
    x._subNode,
    x._propertyFinder,
  )
}
function asAppointment(m: IPSTMessage): IPSTAppointment {
  const x = m as unknown as Record<string, unknown>
  return new (PSTAppointment as unknown as new (...a: unknown[]) => IPSTAppointment)(
    x._rootProvider,
    x._node,
    x._subNode,
    x._propertyFinder,
  )
}

// Drop U+FFFD replacement chars (mis-decoded bytes, e.g. the empty location on a
// canceled meeting that arrives as a single "replacement character") and trim, so
// junk-only values are treated as empty and not rendered.
function cleanStr(s: string): string {
  return (s || '').replace(/�/g, '').trim()
}
const safeStr = (fn: () => string): string => cleanStr(safe(fn, ''))

function buildContactCard(m: IPSTMessage): ContactCard {
  const c = asContact(m)
  const fullName =
    safeStr(() => c.fileUnder) ||
    [safeStr(() => c.givenName), safeStr(() => c.middleName), safeStr(() => c.surname)]
      .filter(Boolean)
      .join(' ') ||
    safeStr(() => m.subject)
  const emails: ContactCard['emails'] = []
  const pushEmail = (address: string, label: string) => {
    if (address) emails.push({ label: label || 'Email', address })
  }
  pushEmail(safeStr(() => c.email1EmailAddress), safeStr(() => c.email1DisplayName))
  pushEmail(safeStr(() => c.email2EmailAddress), safeStr(() => c.email2DisplayName))
  pushEmail(safeStr(() => c.email3EmailAddress), safeStr(() => c.email3DisplayName))
  const phones: ContactCard['phones'] = []
  const pushPhone = (value: string, label: string) => {
    if (value) phones.push({ label, value })
  }
  pushPhone(safeStr(() => c.businessTelephoneNumber), 'Business')
  pushPhone(safeStr(() => c.mobileTelephoneNumber), 'Mobile')
  pushPhone(safeStr(() => c.homeTelephoneNumber), 'Home')
  pushPhone(safeStr(() => c.otherTelephoneNumber), 'Other')
  pushPhone(safeStr(() => c.companyMainPhoneNumber), 'Company')
  pushPhone(safeStr(() => c.businessFaxNumber), 'Business fax')
  const addresses: ContactCard['addresses'] = []
  const pushAddress = (value: string, label: string) => {
    if (value) addresses.push({ label, value })
  }
  pushAddress(safeStr(() => c.workAddress), 'Work')
  pushAddress(safeStr(() => c.homeAddress), 'Home')
  pushAddress(safeStr(() => c.otherAddress), 'Other')
  return {
    fullName,
    emails,
    phones,
    company: safeStr(() => c.companyName),
    jobTitle: safeStr(() => c.title),
    department: safeStr(() => c.departmentName),
    addresses,
    website: safeStr(() => c.businessHomePage) || safeStr(() => c.personalHomePage),
    im: safeStr(() => c.instantMessagingAddress),
    birthday: safe(() => c.birthday, null)?.getTime() ?? null,
  }
}

function buildAppointmentCard(m: IPSTMessage): AppointmentCard {
  const a = asAppointment(m)
  return {
    location: safeStr(() => a.location),
    start: safe(() => a.startTime, null)?.getTime() ?? null,
    end: safe(() => a.endTime, null)?.getTime() ?? null,
    allDay: safe(() => a.subType, false),
    organizer: safeStr(() => m.sentRepresentingName) || safeStr(() => m.senderName),
    requiredAttendees: safeStr(() => a.requiredAttendees) || safeStr(() => a.toAttendees),
    optionalAttendees: safeStr(() => a.ccAttendees),
    recurrence: safe(() => a.isRecurring, false) ? safeStr(() => a.recurrencePattern) : '',
  }
}

// One-off EntryID (MS-OXCDATA): 4-byte flags + 16-byte UID + 2-byte version + 2-byte
// flags, then 3 null-terminated strings (display name, address type, email). The
// 0x8000 flag marks the strings as UTF-16LE rather than 8-bit.
function parseOneOffMember(bytes: Uint8Array, codepage?: number): { name: string; email: string } | null {
  if (bytes.length < 26) return null
  const flags = bytes[22] | (bytes[23] << 8)
  const unicode = (flags & 0x8000) !== 0
  let off = 24
  const readStr = (): string => {
    if (unicode) {
      let end = off
      while (end + 1 < bytes.length && !(bytes[end] === 0 && bytes[end + 1] === 0)) end += 2
      const s = new TextDecoder('utf-16le').decode(bytes.subarray(off, end))
      off = end + 2
      return s
    }
    let end = off
    while (end < bytes.length && bytes[end] !== 0) end++
    // A non-Unicode entry is in the message's code page, not UTF-8; assuming
    // UTF-8 turns an accented or non-Latin member name into nonsense.
    const s = new TextDecoder(codepageToLabel(codepage), { fatal: false }).decode(
      bytes.subarray(off, end),
    )
    off = end + 1
    return s
  }
  const name = cleanStr(readStr())
  readStr() // address type (e.g. SMTP)
  const email = cleanStr(readStr())
  if (!email.includes('@') && !/[a-z0-9]/i.test(name)) return null // drop garbage
  return { name, email }
}

function buildDistListCard(m: IPSTMessage): DistListCard {
  const name =
    safeStr(() => (m as unknown as { displayName: string }).displayName) || safeStr(() => m.subject)
  const members: DistListCard['members'] = []
  try {
    const x = m as unknown as {
      _rootProvider: { getNameToIdMapItem: (key: number, idx: number) => number }
      _propertyFinder: { findByKey: (key: number) => { value: unknown } | undefined }
    }
    // PidLidDistributionListOneOffMembers (0x8054) under PSETID_Address (2).
    const tag = x._rootProvider.getNameToIdMapItem(0x8054, 2)
    const value = tag !== -1 ? x._propertyFinder.findByKey(tag)?.value : undefined
    const list: unknown[] = Array.isArray(value) ? value : value != null ? [value] : []
    for (const item of list) {
      const buf =
        item instanceof ArrayBuffer
          ? new Uint8Array(item)
          : item instanceof Uint8Array
            ? item
            : null
      const parsed = buf ? parseOneOffMember(buf, bodyCodepage(m, true)) : null
      if (parsed) members.push(parsed)
    }
  } catch {
    // best-effort; the name alone is still useful
  }
  return { name, members }
}

type TaskObj = IPSTTask & { taskStartDate: Date | null; taskDueDate: Date | null }
function asTask(m: IPSTMessage): TaskObj {
  const x = m as unknown as Record<string, unknown>
  return new (PSTTask as unknown as new (...a: unknown[]) => TaskObj)(
    x._rootProvider,
    x._node,
    x._subNode,
    x._propertyFinder,
  )
}

function buildTaskCard(m: IPSTMessage): TaskCard {
  const t = asTask(m)
  const statuses = ['Not started', 'In progress', 'Completed', 'Waiting on someone else', 'Deferred']
  const pc = safe(() => t.percentComplete, 0)
  const pr = safe(() => m.priority, 0)
  return {
    status: statuses[safe(() => t.taskStatus, 0)] || '',
    percentComplete: Math.round(pc <= 1 ? pc * 100 : pc),
    startDate: safe(() => t.taskStartDate, null)?.getTime() ?? null,
    dueDate: safe(() => t.taskDueDate, null)?.getTime() ?? null,
    dateCompleted: safe(() => t.taskDateCompleted, null)?.getTime() ?? null,
    owner: safeStr(() => t.taskOwner),
    priority: pr === 1 ? 'high' : pr === -1 ? 'low' : null,
  }
}

// Read a named MAPI property value via the message internals (named id under set index).
function readNamedValue(m: IPSTMessage, namedId: number, setIdx: number): unknown {
  try {
    const x = m as unknown as {
      _rootProvider: { getNameToIdMapItem: (key: number, idx: number) => number }
      _propertyFinder: { findByKey: (key: number) => { value: unknown } | undefined }
    }
    const tag = x._rootProvider.getNameToIdMapItem(namedId, setIdx)
    return tag !== -1 ? x._propertyFinder.findByKey(tag)?.value : undefined
  } catch {
    return undefined
  }
}

function buildJournalCard(m: IPSTMessage): JournalCard {
  // PSETID_Log (6): LogTypeDesc 34578, LogType 34560, LogStart 34566, LogDuration 34567.
  const entryType = cleanStr(
    String(readNamedValue(m, 34578, 6) ?? readNamedValue(m, 34560, 6) ?? ''),
  )
  const startVal = readNamedValue(m, 34566, 6)
  const start =
    startVal instanceof Date ? startVal.getTime() : typeof startVal === 'number' ? startVal : null
  const durVal = readNamedValue(m, 34567, 6)
  return { entryType, start, durationMinutes: typeof durVal === 'number' ? durVal : 0 }
}

async function buildMessageContent(
  m: IPSTMessage,
  msgId: string,
  entry: SourceEntry,
): Promise<MessageContent> {
  const recipients = await safeAsync(() => m.getRecipients(), [])
  const to: RecipientInfo[] = []
  const cc: RecipientInfo[] = []
  const bcc: RecipientInfo[] = []
  for (const r of recipients) {
    const info: RecipientInfo = {
      name: safe(() => r.displayName, ''),
      email: safe(() => r.smtpAddress, '') || safe(() => r.emailAddress, ''),
    }
    const type = safe(() => r.recipientType, Consts.MAPI_TO)
    if (type === Consts.MAPI_CC) cc.push(info)
    else if (type === Consts.MAPI_BCC) bcc.push(info)
    else to.push(info)
  }

  const attachmentHandles = await safeAsync(() => m.getAttachments(), [])
  entry.attachments.set(msgId, attachmentHandles)
  const inlineImages: InlineImage[] = []
  const attachments: AttachmentMeta[] = []
  attachmentHandles.forEach((a, index) => {
    const method = safe(() => a.attachMethod, 0)
    const isEmbedded = method === Consts.ATTACH_EMBEDDED_MSG
    const cid = cleanCid(safe(() => a.contentId, ''))
    const isInline = !!cid || safe(() => a.isAttachmentInvisibleInHtml, false)
    const name = attachmentName(a, index, isEmbedded)
    attachments.push({
      index,
      name,
      size: safe(() => a.filesize, 0) || safe(() => a.size, 0),
      mime: safe(() => a.mimeTag, ''),
      isInline,
      cid: cid || undefined,
      isEmbeddedMessage: isEmbedded,
    })

    if (cid && method === Consts.ATTACH_BY_VALUE) {
      const data = safe(() => a.fileData, undefined)
      if (data && data.byteLength > 0) {
        inlineImages.push({
          cid,
          mime: safe(() => a.mimeTag, '') || guessMimeFromName(name) || 'application/octet-stream',
          data,
        })
      }
    }
  })

  // Unpack a winmail.dat (TNEF) into its real attachments + plain-text body.
  let tnefBody: string | null = null
  const tnefIdx = attachmentHandles.findIndex((a) => {
    const n = (safe(() => a.longFilename, '') || safe(() => a.filename, '')).toLowerCase()
    return n === 'winmail.dat' || safe(() => a.mimeTag, '').toLowerCase() === 'application/ms-tnef'
  })
  if (tnefIdx !== -1) {
    const raw = safe(() => attachmentHandles[tnefIdx].fileData, undefined)
    const parsed = raw && raw.byteLength > 0 ? parseTnef(raw) : null
    if (parsed && (parsed.attachments.length > 0 || parsed.bodyText)) {
      tnefBody = parsed.bodyText
      entry.tnef.set(msgId, parsed.attachments)
      // Replace the opaque winmail.dat chip with the recovered files.
      const at = attachments.findIndex((x) => x.index === tnefIdx)
      if (at !== -1) attachments.splice(at, 1)
      parsed.attachments.forEach((t, i) => {
        attachments.push({
          index: -1 - i,
          name: t.name || `attachment-${i + 1}`,
          size: t.data.byteLength,
          mime: t.mime,
          isInline: false,
          isEmbeddedMessage: false,
        })
      })
    }
  }

  const bodies = extractBodies(m)
  const delivery = safe(() => m.messageDeliveryTime, null)
  const submit = safe(() => m.clientSubmitTime, null)
  const kind = itemKindOf(safe(() => m.messageClass, ''))
  const importanceVal = safe(() => m.importance, 1)
  const sensitivityVal = safe(() => m.sensitivity, 0)
  const flagRaw = safe(() => m.getProperty(0x1090)?.value, 0)
  const flagVal = typeof flagRaw === 'number' ? flagRaw : 0

  // S/MIME: when the email body is empty, recover it from a smime.p7m (opaque
  // signed). Encrypted messages cannot be read without the recipient's key.
  let smimeBody: { html: string | null; text: string | null } | null = null
  let smimeNote: string | null = null
  if (!bodies.html && !bodies.text) {
    const p7mIdx = attachmentHandles.findIndex((a) => {
      const n = (safe(() => a.longFilename, '') || safe(() => a.filename, '')).toLowerCase()
      const mt = safe(() => a.mimeTag, '').toLowerCase()
      return n === 'smime.p7m' || mt === 'application/pkcs7-mime' || mt === 'application/x-pkcs7-mime'
    })
    if (p7mIdx !== -1) {
      const raw = safe(() => attachmentHandles[p7mIdx].fileData, undefined)
      if (raw && raw.byteLength > 0) {
        const res = await extractSmime(raw)
        if (res.kind === 'signed') {
          smimeBody = res.body
          // Files inside the envelope are part of the message, so they are
          // listed like any other attachment rather than being reachable only
          // by saving the envelope. They ride on the same recovered-file list
          // the winmail.dat path uses, which is what serves their bytes.
          const recovered = entry.tnef.get(msgId) ?? []
          const base = recovered.length
          res.body.attachments.forEach((a, i) => {
            recovered.push({ name: a.name, mime: a.mime, data: a.data })
            const index = -1 - (base + i)
            attachments.push({
              index,
              name: a.name || `attachment-${base + i + 1}`,
              size: a.data.byteLength,
              mime: a.mime,
              isInline: !!a.cid,
              cid: a.cid || undefined,
              isEmbeddedMessage: false,
            })
            // Pictures the body refers to by cid have to be present for it to
            // render them.
            if (a.cid && /^image\//i.test(a.mime)) {
              inlineImages.push({ cid: a.cid, mime: a.mime, data: a.data })
            }
          })
          if (recovered.length) entry.tnef.set(msgId, recovered)
          if (res.body.html || res.body.text) {
            smimeNote = null
          }
        } else if (res.kind === 'encrypted') {
          smimeNote =
            "This is an encrypted S/MIME message. It cannot be read without the recipient's private key."
        } else {
          // Otherwise the reader would show a completely blank message.
          smimeNote =
            'This message is wrapped in an S/MIME envelope that could not be decoded. ' +
            'The original is attached as smime.p7m.'
        }
      }
    }
  }
  const finalHtml = bodies.html || smimeBody?.html || null
  const finalText = bodies.text || tnefBody || smimeBody?.text || smimeNote || null

  // Build the contact / dist-list cards up front so the view title can fall back
  // to their name (contacts often have no PR_SUBJECT), and the card body need not
  // repeat the name the header already shows. A .msg-backed message has no PST
  // named-property machinery, so its cards come straight from the parsed fields.
  const msgFields = msgFieldsOf(m)
  const contactCard =
    kind === 'contact'
      ? msgFields
        ? msgContactCard(msgFields, safe(() => m.subject, ''))
        : safe(() => buildContactCard(m), undefined)
      : undefined
  const distlistCard = kind === 'distlist' ? safe(() => buildDistListCard(m), undefined) : undefined

  return {
    itemKind: kind,
    categories: safe(() => m.colorCategories, [])
      .map((s) => cleanStr(s))
      .filter(Boolean),
    importance: importanceVal === 2 ? 'high' : importanceVal === 0 ? 'low' : null,
    sensitivity:
      sensitivityVal === 1
        ? 'personal'
        : sensitivityVal === 2
          ? 'private'
          : sensitivityVal === 3
            ? 'confidential'
            : null,
    followUp: flagVal === 2 ? 'flagged' : flagVal === 1 ? 'complete' : null,
    subject:
      safe(() => m.subject, '') || contactCard?.fullName || distlistCard?.name || '(no subject)',
    fromName: safe(() => m.senderName, '') || safe(() => m.sentRepresentingName, ''),
    fromEmail:
      safe(() => m.senderEmailAddress, '') || safe(() => m.sentRepresentingEmailAddress, ''),
    to,
    cc,
    bcc,
    date: (delivery ?? submit)?.getTime() ?? null,
    html: finalHtml,
    text: finalText,
    inlineImages,
    attachments,
    headers: safe(() => m.transportMessageHeaders, ''),
    contact: contactCard,
    appointment:
      kind === 'appointment'
        ? msgFields
          ? msgAppointmentCard(
              msgFields,
              safeStr(() => m.sentRepresentingName) || safeStr(() => m.senderName),
            )
          : safe(() => buildAppointmentCard(m), undefined)
        : undefined,
    distlist: distlistCard,
    task: kind === 'task' ? safe(() => buildTaskCard(m), undefined) : undefined,
    journal: kind === 'journal' ? safe(() => buildJournalCard(m), undefined) : undefined,
  }
}

/**
 * Collapse the several ways the same person appears into one entry.
 *
 * The same address turns up written differently across a mailbox: with a
 * display name, without one, or with the address repeated as the name. Those
 * are one person, and offering four spellings of them as separate suggestions
 * is just noise. Entries are grouped by address, the best name seen for that
 * address wins, and a name-only entry joins the group that already uses it.
 */
function unifyPeople(entries: { label: string; count: number }[]): { label: string; count: number }[] {
  const addressOf = (label: string): string => {
    const angled = /<([^>]+)>\s*$/.exec(label)?.[1]
    if (angled?.includes('@')) return angled.trim().toLowerCase()
    const bare = label.trim()
    return !bare.includes('<') && bare.includes('@') ? bare.toLowerCase() : ''
  }
  const nameOf = (label: string): string => label.replace(/<[^>]*>\s*$/, '').trim()

  const groups = new Map<string, { address: string; name: string; count: number }>()
  const nameOnly: { label: string; count: number }[] = []

  for (const e of entries) {
    const address = addressOf(e.label)
    if (!address) {
      nameOnly.push(e)
      continue
    }
    const name = nameOf(e.label)
    // A "name" that is just the address again tells us nothing.
    const realName = name && name.toLowerCase() !== address && !name.includes('@') ? name : ''
    const g = groups.get(address)
    if (g) {
      g.count += e.count
      if (!g.name && realName) g.name = realName
    } else {
      groups.set(address, { address, name: realName, count: e.count })
    }
  }

  // Fold a bare name into the address that already goes by it.
  const leftovers: { label: string; count: number }[] = []
  for (const e of nameOnly) {
    const match = [...groups.values()].find(
      (g) => g.name && g.name.toLowerCase() === e.label.trim().toLowerCase(),
    )
    if (match) match.count += e.count
    else leftovers.push(e)
  }

  return [
    ...[...groups.values()].map((g) => ({
      label: g.name ? `${g.name} <${g.address}>` : g.address,
      count: g.count,
    })),
    ...leftovers,
  ]
}

const api = {
  async ping(): Promise<'pong'> {
    return 'pong'
  },

  /** Tell the worker what a source is called, so `mailbox:` can match it. */
  async setSourceLabel(sourceId: string, label: string): Promise<void> {
    const entry = sources.get(sourceId)
    if (entry) entry.label = label
  },

  /** Open a PST/OST File, walk its folder tree, and return a serializable index. */
  async openSource(sourceId: string, file: File): Promise<SourceIndex> {
    sources.delete(sourceId)

    // A cleanly-openable file takes the normal path; when its header or index
    // b-trees are damaged, fall back to built-in recovery (see salvage.ts).
    let pstFile: IPSTFile
    let recovered = false
    let reader: ChunkedReader | undefined
    try {
      reader = makeChunkedReader(file)
      pstFile = await openPst(reader)
    } catch (primaryError) {
      reader = undefined
      const attempt = await safeAsync(() => salvageOpenPst(file), null)
      if (!attempt) throw primaryError
      pstFile = attempt.pst
      recovered = true
    }
    const entry: SourceEntry = {
      file: pstFile,
      reader,
      folders: new Map(),
      messages: new Map(),
      attachments: new Map(),
      ocr: new Map(),
      bodyImageCount: new Map(),
      imageAttachments: new Map(),
      searchIds: new Set(),
      tnef: new Map(),
      emailLists: new Map(),
      folderNames: new Map(),
    }
    sources.set(sourceId, entry)

    // Walk the whole tree once, then pick the subtree that actually holds the
    // mailbox (see selectMailboxTree - the library's own top-of-file answer is
    // just one candidate, since it is unreliable for .ost files).
    let libraryTopId: string | null = null
    try {
      libraryTopId = String((await pstFile.getTopOfOutlookDataFile()).primaryNodeId)
    } catch {
      libraryTopId = null
    }
    const fullTree = await buildFolderTree(await pstFile.getRootFolder(), entry)
    const { tree: rootNode, ownerHint } = selectMailboxTree(fullTree, libraryTopId)
    pruneFolderHandles(entry, rootNode)

    // A previous session's finished search index for this exact file (same
    // name/size/mtime) lets indexSource skip re-reading every message.
    entry.fingerprint = fingerprintOf(file)
    const cached = await getCachedIndex(entry.fingerprint)
    entry.cachedDocs = cached?.docs ?? null
    if (cached?.people.length) {
      entry.people = new Map(cached.people.map(([label, count]) => [label.toLowerCase(), { label, count }]))
    }

    let totalMessages = 0
    const sum = (n: FolderNode) => {
      totalMessages += n.messageCount
      n.children.forEach(sum)
    }
    sum(rootNode)

    // Prefer the mailbox's own name when it is meaningful, but Outlook gives
    // every personal data file a generic name ("Personal Folders" etc.); in that
    // case the filename the user chose is the better label.
    const storeName = await safeAsync(
      async () => (await pstFile.getMessageStore()).displayName,
      '',
    )
    const ownerName =
      [storeName, ownerHint].find((n) => n && !isGenericStoreName(n)) ?? ''

    return {
      rootFolder: rootNode,
      totalMessages,
      suggestedLabel: ownerName || prettyFileName(file.name),
      recovered,
    }
  },

  /**
   * Open one or more standalone message files (.msg or .eml, told apart by the
   * CFB magic rather than the extension) as a single synthetic mailbox with
   * one "Messages" folder. Unparseable files are skipped and surfaced through
   * the folder's unreadable count; throws only when nothing could be read.
   */
  async openMsgSource(sourceId: string, files: File[]): Promise<SourceIndex> {
    sources.delete(sourceId)

    const messages: IPSTMessage[] = []
    let failed = 0
    for (let i = 0; i < files.length; i++) {
      try {
        const data = await files[i].arrayBuffer()
        messages.push(isCfbFile(data) ? parseMsg(data, `msg${i}`) : await parseEml(data, `msg${i}`))
      } catch {
        failed++
      }
    }
    if (messages.length === 0) {
      throw new Error(
        files.length === 1
          ? 'The file could not be parsed as an email message.'
          : 'None of the files could be parsed as email messages.',
      )
    }

    const entry: SourceEntry = {
      file: { close: async () => {} } as unknown as IPSTFile,
      folders: new Map(),
      messages: new Map(),
      attachments: new Map(),
      ocr: new Map(),
      bodyImageCount: new Map(),
      imageAttachments: new Map(),
      searchIds: new Set(),
      tnef: new Map(),
      emailLists: new Map(),
      folderNames: new Map(),
    }

    // Standalone files carry no folder tree, so bucket items into Outlook-like
    // folders by item type (a saved contact lands under Contacts, and so on).
    const BUCKETS: Record<ReturnType<typeof itemKindOf>, { id: string; name: string; cls: string }> = {
      email: { id: 'msgfolder', name: 'Messages', cls: 'IPF.Note' },
      contact: { id: 'msgcontacts', name: 'Contacts', cls: 'IPF.Contact' },
      distlist: { id: 'msgcontacts', name: 'Contacts', cls: 'IPF.Contact' },
      appointment: { id: 'msgcalendar', name: 'Calendar', cls: 'IPF.Appointment' },
      task: { id: 'msgtasks', name: 'Tasks', cls: 'IPF.Task' },
      note: { id: 'msgnotes', name: 'Notes', cls: 'IPF.StickyNote' },
      journal: { id: 'msgjournal', name: 'Journal', cls: 'IPF.Journal' },
    }
    const grouped = new Map<string, { name: string; cls: string; items: IPSTMessage[] }>()
    for (const m of messages) {
      const b = BUCKETS[itemKindOf(safe(() => m.messageClass, ''))]
      const g = grouped.get(b.id) ?? { name: b.name, cls: b.cls, items: [] }
      g.items.push(m)
      grouped.set(b.id, g)
    }

    const children: FolderNode[] = []
    for (const id of ['msgfolder', 'msgcalendar', 'msgcontacts', 'msgtasks', 'msgnotes', 'msgjournal']) {
      const g = grouped.get(id)
      if (!g) continue
      entry.folders.set(id, createMsgFolder(id, g.name, g.items, g.cls))
      entry.folderNames.set(id, g.name)
      children.push({
        id,
        name: g.name,
        containerClass: g.cls,
        messageCount: g.items.length,
        children: [],
      })
    }
    if (failed && children.length) {
      // Files that would not parse belong to no folder, so put the count on
      // Messages rather than whichever bucket happens to be first: a warning
      // about unreadable mail sitting on Contacts reads as a different problem.
      const home = children.find((c) => c.name === 'Messages') ?? children[0]
      entry.extraUnreadable = new Map([[home.id, failed]])
    }
    sources.set(sourceId, entry)

    const label =
      files.length === 1 ? prettyFileName(files[0].name) : `Messages (${files.length})`
    return {
      rootFolder: {
        id: 'msgstore',
        name: label,
        containerClass: '',
        messageCount: 0,
        children,
      },
      totalMessages: messages.length,
      suggestedLabel: label,
    }
  },

  /** Load metadata for every message in one folder, reporting any that could
   *  not be read (so a damaged file shows what survives, plus a salvage count). */
  async getFolderMessages(sourceId: string, folderId: string): Promise<FolderMessages> {
    const entry = sources.get(sourceId)
    if (!entry) return { messages: [], unreadable: 0 }
    const folder = entry.folders.get(folderId)
    if (!folder) return { messages: [], unreadable: 0 }

    let emails: IPSTMessage[] = []
    let enumFailed = false
    try {
      emails = await folderEmails(entry, folderId)
    } catch {
      enumFailed = true
    }
    const metas: MessageMeta[] = []
    let failed = 0
    for (const m of emails) {
      try {
        metas.push(toMeta(m, folderId))
      } catch {
        // Skip an individual unreadable message rather than failing the folder.
        failed++
      }
    }
    // If the whole table was unreadable, fall back to the folder's declared count
    // so the user still learns the contents are damaged.
    const unreadable = enumFailed
      ? Math.max(safe(() => folder.contentCount, 0), 1)
      : failed + (entry.extraUnreadable?.get(folderId) ?? 0)
    return { messages: metas, unreadable }
  },

  /** Fetch full body + headers + inline images + attachment list for one message. */
  async getMessageContent(
    sourceId: string,
    messageId: string,
  ): Promise<MessageContent | null> {
    const entry = sources.get(sourceId)
    if (!entry) return null
    const m = entry.messages.get(messageId)
    if (!m) return null
    return buildMessageContent(m, messageId, entry)
  },

  /** Fetch raw bytes for one attachment (transferred, zero-copy). */
  async getAttachmentData(
    sourceId: string,
    messageId: string,
    index: number,
  ): Promise<AttachmentData | null> {
    const entry = sources.get(sourceId)
    if (!entry) return null
    // Negative index = an attachment recovered from a winmail.dat (TNEF).
    if (index < 0) {
      const t = entry.tnef.get(messageId)?.[-1 - index]
      if (!t) return null
      const tCopy = t.data.slice(0)
      return Comlink.transfer({ name: t.name, mime: t.mime, data: tCopy }, [tCopy])
    }
    let list = entry.attachments.get(messageId)
    if (!list) {
      // Indexing does not keep attachment handles, so fetch them now. Opening
      // a message caches them; OCR and direct downloads can arrive first.
      const m = entry.messages.get(messageId)
      list = m ? await safeAsync(() => m.getAttachments(), []) : undefined
      if (list) entry.attachments.set(messageId, list)
    }
    const a = list?.[index]
    if (!a) return null
    const data = safe(() => a.fileData, undefined)
    if (!data || data.byteLength === 0) return null
    // Copy so transferring (detaching) doesn't break the library's cached buffer.
    const copy = data.slice(0)
    const result: AttachmentData = {
      name: attachmentName(a, index, false),
      mime: safe(() => a.mimeTag, ''),
      data: copy,
    }
    return Comlink.transfer(result, [copy])
  },

  /** Open an embedded (nested) email attachment and return its content. */
  async getEmbeddedMessageContent(
    sourceId: string,
    parentMessageId: string,
    index: number,
  ): Promise<EmbeddedMessageResult | null> {
    const entry = sources.get(sourceId)
    if (!entry) return null
    const list = entry.attachments.get(parentMessageId)
    const a = list?.[index]
    if (!a) return null
    const embedded = await safeAsync(() => a.getEmbeddedPSTMessage(), null)
    if (!embedded) return null
    const embId = `${parentMessageId}/emb${index}`
    entry.messages.set(embId, embedded)
    const content = await buildMessageContent(embedded, embId, entry)
    return { id: embId, content }
  },

  /** Parse a .msg or .eml file attached as a regular file (not embedded) and
   *  return its content, registered like an embedded message so its own
   *  attachments and nested messages resolve. The format is told apart by the
   *  CFB magic. Negative index = a TNEF-recovered attachment. */
  async openAttachedEmail(
    sourceId: string,
    parentMessageId: string,
    index: number,
  ): Promise<EmbeddedMessageResult | null> {
    const entry = sources.get(sourceId)
    if (!entry) return null
    let raw: ArrayBuffer | undefined
    if (index < 0) {
      raw = entry.tnef.get(parentMessageId)?.[-1 - index]?.data
    } else {
      let list = entry.attachments.get(parentMessageId)
      if (!list) {
        const parent = entry.messages.get(parentMessageId)
        list = parent ? await safeAsync(() => parent.getAttachments(), []) : undefined
        if (list) entry.attachments.set(parentMessageId, list)
      }
      const a = list?.[index]
      raw = a ? safe(() => a.fileData, undefined) : undefined
    }
    if (!raw || raw.byteLength === 0) return null
    const embId = `${parentMessageId}/msg${index}`
    let msg: IPSTMessage
    try {
      msg = isCfbFile(raw) ? parseMsg(raw, embId) : await parseEml(raw, embId)
    } catch {
      return null
    }
    entry.messages.set(embId, msg)
    const content = await buildMessageContent(msg, embId, entry)
    return { id: embId, content }
  },

  /**
   * Build the full-text search index for a source in the background.
   * Walks every folder, indexing subject/from/to/body/attachment-names, and
   * warms the message + attachment caches as a side effect.
   */
  async indexSource(
    sourceId: string,
    onProgress?: (done: number, total: number) => void,
  ): Promise<{ fromCache: boolean; complete: boolean }> {
    const entry = sources.get(sourceId)
    if (!entry) return { fromCache: false, complete: false }

    // What the mailbox says it holds. Used to report progress, and to judge
    // whether a pass actually covered it.
    let total = 0
    for (const folder of entry.folders.values()) total += safe(() => folder.contentCount, 0)

    // Cache hit: register the stored docs (rewritten to this session's source
    // id) and skip the walk entirely. OCR text from the original pass is
    // already inside them, so no OCR pass is needed either.
    //
    // Only a pass that covered the whole mailbox is ever stored (see
    // releaseSearchDocs), and the cache version was bumped to drop entries
    // written before that rule existed, so a hit here is known to be whole.
    if (entry.cachedDocs && entry.cachedDocs.length) {
      const docs: SearchDoc[] = []
      for (const d of entry.cachedDocs) {
        const doc = { ...d, sourceId, id: `${sourceId}:${d.messageId}` }
        if (searchIndex.has(doc.id)) continue
        docs.push(doc)
        entry.searchIds.add(doc.id)
        metaDocs.set(doc.id, metaOf(doc))
      }
      entry.cachedDocs = null
      if (docs.length) searchIndex.addAll(docs)
      onProgress?.(docs.length, docs.length)
      entry.indexComplete = true
      return { fromCache: true, complete: true }
    }

    let done = 0
    // Folders whose message list could not be read at all. Each one hides
    // every message it holds from search, so the pass is not complete.
    let folderFailures = 0

    for (const folderId of entry.folders.keys()) {
      if (!sources.has(sourceId)) return { fromCache: false, complete: false } // source removed mid-index
      const read = await readFolderUnderPressure(entry, folderId)
      if (read === null) folderFailures++
      const emails = read ?? []
      const docs: SearchDoc[] = []
      for (const m of emails) {
        const msgId = String(m.primaryNodeId)
        const id = `${sourceId}:${msgId}`
        done++
        if (searchIndex.has(id)) continue
        try {
          const doc = await buildSearchDoc(sourceId, folderId, msgId, m, entry)
          docs.push(doc)
          searchDocs.set(id, doc)
          entry.searchIds.add(id)
          metaDocs.set(id, metaOf(doc))
        } catch {
          // skip an unreadable message
        }
      }
      // If the source was closed while reading this folder, drop what we staged
      // instead of leaving orphaned docs in the shared search index.
      if (!sources.has(sourceId)) {
        for (const d of docs) searchDocs.delete(d.id)
        return { fromCache: false, complete: false }
      }
      if (docs.length) searchIndex.addAll(docs)
      onProgress?.(done, total)
    }
    onProgress?.(done, total)
    // Individually unreadable messages are normal and are skipped above; a
    // folder that could not be read at all is not, and neither is a pass that
    // ends up covering only part of what the mailbox declares.
    // `done` counts every message the walk actually saw, so it lands on the
    // declared total when no folder was lost. The indexed-document count is
    // deliberately not used: a message filed in two folders is indexed once,
    // which would read as missing mail.
    const complete = folderFailures === 0 && coversMailbox(done, total)
    entry.indexComplete = complete
    return { fromCache: false, complete }
  },

  /**
   * Find contacts matching a clicked sender/recipient, across every loaded
   * mailbox's contact folders. Deterministic on purpose: an exact email match
   * when the recipient has a real address, otherwise exact (case-insensitive)
   * display-name equality. Multiple exact matches are all returned so the UI
   * can offer the choice instead of guessing.
   */
  async findContacts(email: string, name: string): Promise<ContactMatch[]> {
    const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ')
    const wantEmail = email.includes('@') ? norm(email) : ''
    const wantName = norm(name)
    if (!wantEmail && !wantName) return []

    const results: ContactMatch[] = []
    for (const [sourceId, entry] of sources) {
      for (const [folderId, folder] of entry.folders) {
        if (!safe(() => folder.containerClass, '').toLowerCase().startsWith('ipf.contact')) continue
        const msgs = await safeAsync(() => folderEmails(entry, folderId), [])
        for (const m of msgs) {
          if (!safe(() => m.messageClass, '').toLowerCase().startsWith('ipm.contact')) continue
          const msgId = String(safe(() => m.primaryNodeId, 0))
          if (msgId === '0') continue
          const fields = msgFieldsOf(m)
          const card = fields
            ? msgContactCard(fields, safe(() => m.subject, ''))
            : safe(() => buildContactCard(m), undefined)
          if (!card) continue
          const emails = card.emails.map((e) => norm(e.address)).filter(Boolean)
          const names = [card.fullName, safe(() => m.subject, '')].map(norm).filter(Boolean)
          const hit = wantEmail ? emails.includes(wantEmail) : names.includes(wantName)
          if (!hit) continue
          entry.messages.set(msgId, m)
          results.push({
            sourceId,
            messageId: msgId,
            name: card.fullName || safe(() => m.subject, ''),
            email: card.emails[0]?.address ?? '',
          })
          if (results.length >= 8) return results
        }
      }
    }
    return results
  },

  /** People suggestions for the search filters, most-seen first. */
  async suggestPeople(q: string, limit = 8): Promise<string[]> {
    const needle = q.trim().toLowerCase()
    const agg = new Map<string, { label: string; count: number }>()
    for (const entry of sources.values()) {
      for (const [key, p] of entry.people ?? []) {
        if (needle && !key.includes(needle)) continue
        const a = agg.get(key)
        if (a) a.count += p.count
        else agg.set(key, { ...p })
      }
    }
    return unifyPeople([...agg.values()])
      .sort((a, b) => b.count - a.count)
      .slice(0, limit)
      .map((p) => p.label)
  },

  /**
   * Search across all indexed sources. Plain words are fuzzy (typo-tolerant),
   * digit-bearing terms exact. The query also understands:
   *   "quoted text"       exact phrase
   *   from: to: subject:  field contains the value
   *   person:x            from OR to contains the value
   *   has:attachment      only messages with attachments
   *   is:high|low|flagged|unread
   *   before:/after:      date bound (YYYY-MM-DD)
   */
  /** Every message matching the query. Nothing is trimmed: a review has to be
   *  able to trust that what is listed is all there is. */
  async search(query: string): Promise<SearchHit[]> {
    const q = query.trim()
    if (!q) return []

    // Parse: quoted phrases, key:value filters (value may be quoted), terms.
    const phrases: string[] = []
    const terms: string[] = []
    const filters: Record<string, string[]> = {}
    const TOKEN = /(\w+):"([^"]*)"|(\w+):(\S+)|"([^"]*)"|(\S+)/g
    const KEYS = new Set(['from', 'to', 'subject', 'person', 'has', 'is', 'before', 'after', 'mailbox', 'folder'])
    let tok: RegExpExecArray | null
    while ((tok = TOKEN.exec(q))) {
      const key = (tok[1] ?? tok[3])?.toLowerCase()
      const val = tok[2] ?? tok[4]
      if (key && KEYS.has(key) && val) {
        ;(filters[key] ??= []).push(val.toLowerCase())
      } else if (tok[5] !== undefined) {
        if (tok[5].trim()) phrases.push(tok[5].toLowerCase())
      } else {
        terms.push(tok[6] ?? `${key}:${val}`)
      }
    }

    // Candidates: full-text over free terms plus the words inside phrases
    // (exact words, adjacency verified later); with neither, every message.
    const ftQuery = [...terms, ...phrases.flatMap((p) => p.split(/\s+/))].join(' ')
    let candidates: { meta: MetaDoc; score: number }[]
    if (ftQuery.trim()) {
      const phraseWords = new Set(phrases.flatMap((p) => p.split(/\s+/)))
      candidates = searchIndex
        .search(ftQuery, {
          combineWith: 'AND',
          fuzzy: (term) => (/\d/.test(term) || phraseWords.has(term) ? false : 0.2),
          prefix: (term) => !phraseWords.has(term),
        })
        .map((r) => ({ meta: metaDocs.get(r.id as string), score: r.score }))
        .filter((c): c is { meta: MetaDoc; score: number } => c.meta !== undefined)
    } else {
      candidates = [...metaDocs.values()].map((meta) => ({ meta, score: 0 }))
    }

    // Field filters over the in-memory metadata.
    const has = (hay: string, needles: string[] | undefined) =>
      !needles || needles.every((n) => hay.toLowerCase().includes(n))
    // A bare date means that day in the reader's own timezone. Date.parse
    // treats "2024-01-01" as UTC midnight, which in other zones pulls in the
    // evening before or drops the morning of.
    const dateBound = (v: string[] | undefined) => {
      if (!v) return null
      const raw = v[v.length - 1]
      const ymd = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw)
      const t = ymd
        ? new Date(Number(ymd[1]), Number(ymd[2]) - 1, Number(ymd[3])).getTime()
        : Date.parse(raw)
      return Number.isNaN(t) ? null : t
    }
    const before = dateBound(filters.before)
    const after = dateBound(filters.after)
    candidates = candidates.filter(({ meta }) => {
      if (!has(meta.from, filters.from)) return false
      if (!has(meta.to, filters.to)) return false
      if (!has(meta.subject, filters.subject)) return false
      if (filters.person && !filters.person.every((p) =>
        meta.from.toLowerCase().includes(p) || meta.to.toLowerCase().includes(p))) return false
      if (filters.has?.some((h) => h.startsWith('attach')) && !meta.hasAttachments) return false
      // Scope: limit the search to a mailbox or a folder by name. Several
      // values are treated as "any of", so `folder:inbox folder:sent` widens
      // rather than contradicting itself.
      if (filters.mailbox) {
        const label = (sources.get(meta.sourceId)?.label ?? '').toLowerCase()
        if (!filters.mailbox.some((m) => label.includes(m))) return false
      }
      if (filters.folder) {
        const name = (
          sources.get(meta.sourceId)?.folderNames.get(meta.folderId) ?? ''
        ).toLowerCase()
        if (!filters.folder.some((f) => name.includes(f))) return false
      }
      if (filters.is) {
        for (const f of filters.is) {
          // An unknown value matches nothing: silently ignoring it would
          // widen the search when the user meant to narrow it.
          if (f === 'high') { if (meta.importance !== 'high') return false }
          else if (f === 'low') { if (meta.importance !== 'low') return false }
          else if (f === 'flagged') { if (!meta.flagged) return false }
          else if (f === 'unread') { if (!meta.unread) return false }
          else if (f === 'read') { if (meta.unread) return false }
          else return false
        }
      }
      if (before !== null && (meta.date === null || meta.date >= before)) return false
      if (after !== null && (meta.date === null || meta.date < after)) return false
      return true
    })

    // Exact phrases: verify adjacency against the real text. Docs still in
    // memory are checked directly; released ones load from the on-device
    // index cache, per source, once per search.
    if (phrases.length) {
      const hayOf = (d: { subject: string; from: string; to: string; body?: string; attachments?: string; ocr?: string }) =>
        `${d.subject}\n${d.from}\n${d.to}\n${d.body ?? ''}\n${d.attachments ?? ''}\n${d.ocr ?? ''}`.toLowerCase()
      const perSource = new Map<string, Map<string, string>>()
      const verified: typeof candidates = []
      for (const c of candidates) {
        let hay: string | undefined
        const inMem = searchDocs.get(c.meta.id)
        if (inMem) {
          hay = hayOf(inMem)
        } else {
          let m = perSource.get(c.meta.sourceId)
          if (!m) {
            m = new Map()
            const fp = sources.get(c.meta.sourceId)?.fingerprint
            if (fp) {
              for (const d of (await getCachedIndex(fp))?.docs ?? []) m.set(d.messageId, hayOf(d))
            }
            perSource.set(c.meta.sourceId, m)
          }
          hay = m.get(c.meta.messageId) ?? hayOf(c.meta)
        }
        if (phrases.every((p) => hay!.includes(p))) verified.push(c)
      }
      candidates = verified
    }

    if (!ftQuery.trim()) candidates.sort((a, b) => (b.meta.date ?? 0) - (a.meta.date ?? 0))
    const hits = candidates.map(({ meta, score }) => ({
      sourceId: meta.sourceId,
      messageId: meta.messageId,
      folderId: meta.folderId,
      subject: meta.subject,
      from: meta.from,
      date: meta.date,
      hasAttachments: meta.hasAttachments,
      score,
    }))
    return hits
  },

  /** Every image to OCR across a source: image attachments plus data: body images. */
  async listOcrImages(sourceId: string): Promise<OcrTarget[]> {
    const entry = sources.get(sourceId)
    if (!entry) return []
    const out: OcrTarget[] = []
    for (const [messageId, indexes] of entry.imageAttachments) {
      for (const index of indexes) out.push({ messageId, kind: 'att', ref: index })
    }
    for (const [messageId, count] of entry.bodyImageCount) {
      for (let i = 0; i < count; i++) out.push({ messageId, kind: 'body', ref: i })
    }
    return out
  },

  /** Bytes for the ref-th data: image in a message body (transferred, zero-copy). */
  async getBodyImageData(
    sourceId: string,
    messageId: string,
    ref: number,
  ): Promise<AttachmentData | null> {
    const entry = sources.get(sourceId)
    const m = entry?.messages.get(messageId)
    if (!m) return null
    const url = dataImageUrls(extractBodies(m).html)[ref]
    const decoded = url ? dataUrlToBytes(url) : null
    if (!decoded) return null
    const result: AttachmentData = { name: `body-image-${ref}`, mime: decoded.mime, data: decoded.data }
    return Comlink.transfer(result, [decoded.data])
  },

  /** Merge OCR text into a message's search-index entry, keyed per image so a
   *  match can be traced back to a specific attachment or body image. */
  async addOcrText(
    sourceId: string,
    messageId: string,
    kind: OcrTarget['kind'],
    ref: number,
    text: string,
  ): Promise<void> {
    const entry = sources.get(sourceId)
    if (entry) entry.ocr.set(`${kind}:${messageId}:${ref}`, text)
    const id = `${sourceId}:${messageId}`
    const doc = searchDocs.get(id)
    if (!doc) return
    doc.ocr = doc.ocr ? `${doc.ocr} ${text}` : text
    if (searchIndex.has(id)) searchIndex.replace(doc)
  },

  /** Which images of a message contain the query text (via OCR). */
  async ocrMatches(sourceId: string, messageId: string, query: string): Promise<OcrMatchResult> {
    const empty: OcrMatchResult = { attachmentIndexes: [], bodyImageIndexes: [] }
    const entry = sources.get(sourceId)
    if (!entry) return empty
    const terms = queryTerms(query)
    if (!terms.length) return empty
    const attPrefix = `att:${messageId}:`
    const bodyPrefix = `body:${messageId}:`
    const attachmentIndexes: number[] = []
    const bodyImageIndexes: number[] = []
    for (const [key, text] of entry.ocr) {
      const low = text.toLowerCase()
      if (!terms.some((t) => low.includes(t))) continue
      if (key.startsWith(attPrefix)) attachmentIndexes.push(Number(key.slice(attPrefix.length)))
      else if (key.startsWith(bodyPrefix)) bodyImageIndexes.push(Number(key.slice(bodyPrefix.length)))
    }
    return {
      attachmentIndexes: attachmentIndexes.sort((a, b) => a - b),
      bodyImageIndexes: bodyImageIndexes.sort((a, b) => a - b),
    }
  },

  /** Free the staged search docs for a source once its OCR pass is done. They
   *  are kept only so OCR text can be merged into the index; the search index
   *  keeps its own copy, so dropping them reclaims the duplicated message bodies. */
  async releaseSearchDocs(sourceId: string): Promise<void> {
    const entry = sources.get(sourceId)
    if (!entry) return
    // The docs are final at this point (OCR text merged in, or OCR skipped),
    // so persist them for instant indexing when this file is opened again.
    if (entry.fingerprint) {
      const docs = [...entry.searchIds]
        .map((id) => searchDocs.get(id))
        .filter((d): d is SearchDoc => d !== undefined)
      let stored = false
      // Never persist a pass that missed part of the mailbox: the stored copy
      // is reused on every future open, so a partial one would turn a passing
      // memory shortage into permanently incomplete search.
      if (docs.length && entry.indexComplete !== false) {
        const people: [string, number][] = [...(entry.people?.values() ?? [])].map((p) => [
          p.label,
          p.count,
        ])
        stored = await putCachedIndex(entry.fingerprint, docs, people)
      }
      // Only let go of the text once it is safely stored. If the write was
      // refused (quota, private browsing) these copies are the only place the
      // message bodies exist, and exact-phrase search reads them to confirm a
      // match. Dropping them anyway would make quoted searches silently stop
      // finding things that are there.
      if (stored || !docs.length) {
        for (const id of entry.searchIds) searchDocs.delete(id)
      }
    }
    // Sources without a fingerprint (standalone .msg/.eml batches) keep their
    // docs in memory: they are small, and exact-phrase search needs the text.
  },

  /** Release a source, its PST handle, and its search-index entries. */
  async closeSource(sourceId: string): Promise<void> {
    const entry = sources.get(sourceId)
    if (!entry) return
    // Remove from the registry first (synchronously) so in-flight indexing or
    // OCR sees the source as gone and stops adding to the shared index.
    sources.delete(sourceId)
    for (const id of entry.searchIds) {
      if (searchIndex.has(id)) searchIndex.discard(id)
      searchDocs.delete(id)
      metaDocs.delete(id)
    }
    await safeAsync(() => entry.file.close(), undefined)
  },
}

export type PstWorkerApi = typeof api

Comlink.expose(api)
