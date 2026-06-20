import * as Comlink from 'comlink'
import MiniSearch from 'minisearch'
import { queryTerms } from '../lib/highlight'
import { parseTnef, type TnefAttachment } from '../lib/tnef'
import { extractSmime } from '../lib/smime'
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
  type ReadFileApi,
} from '@hiraokahypertools/pst-extractor'
import type {
  AppointmentCard,
  AttachmentData,
  AttachmentMeta,
  ContactCard,
  DistListCard,
  EmbeddedMessageResult,
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
  folders: Map<string, IPSTFolder>
  messages: Map<string, IPSTMessage>
  /** Cached attachment handles per message id, for lazy byte fetching. */
  attachments: Map<string, IPSTAttachment[]>
  /** OCR text per image, keyed `${kind}:${messageId}:${ref}` (for locating matches). */
  ocr: Map<string, string>
  /** Count of data: images in each message body (only messages that have any). */
  bodyImageCount: Map<string, number>
  /** Search-index document ids contributed by this source (for cleanup). */
  searchIds: Set<string>
  /** Attachments recovered from a winmail.dat (TNEF), keyed by message id. */
  tnef: Map<string, TnefAttachment[]>
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
}

const searchIndex = new MiniSearch<SearchDoc>({
  idField: 'id',
  fields: ['subject', 'from', 'to', 'body', 'attachments', 'ocr'],
  storeFields: ['sourceId', 'messageId', 'folderId', 'subject', 'from', 'date', 'hasAttachments'],
  searchOptions: { boost: { subject: 3, from: 2 }, fuzzy: 0.2, prefix: true },
})

/** Keep the indexed docs so OCR text can be merged in later (replace). */
const searchDocs = new Map<string, SearchDoc>()

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

/** A random-access reader over a File: reads only the bytes asked for. */
function makeReader(file: File): ReadFileApi {
  return {
    readFile: async (buffer, offset, length, position) => {
      const slice = file.slice(position, position + length)
      const ab = await slice.arrayBuffer()
      const src = new Uint8Array(ab)
      new Uint8Array(buffer).set(src, offset)
      return src.byteLength
    },
    close: async () => {},
  }
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

async function buildFolderTree(folder: IPSTFolder, entry: SourceEntry): Promise<FolderNode> {
  const id = String(folder.primaryNodeId)
  entry.folders.set(id, folder)
  const subs = await safeAsync(() => folder.getSubFolders(), [] as IPSTFolder[])
  const children: FolderNode[] = []
  for (const sub of subs) {
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
    attachments = list
      .map((a) => safe(() => a.longFilename, '') || safe(() => a.filename, ''))
      .filter(Boolean)
      .join(' ')
  }

  const delivery = safe(() => m.messageDeliveryTime, null)
  const submit = safe(() => m.clientSubmitTime, null)

  return {
    id: `${sourceId}:${msgId}`,
    sourceId,
    messageId: msgId,
    folderId,
    subject: safe(() => m.subject, ''),
    from: `${safe(() => m.senderName, '')} ${safe(() => m.senderEmailAddress, '')}`.trim(),
    to: `${safe(() => m.displayTo, '')} ${safe(() => m.displayCC, '')}`.trim(),
    body,
    attachments,
    ocr: '',
    date: (delivery ?? submit)?.getTime() ?? null,
    hasAttachments: safe(() => m.hasAttachments, false),
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
    n === 'root - mailbox'
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
    default:
      return 'utf-8'
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

function bodyCodepage(m: IPSTMessage): number | undefined {
  const cp = safe(() => m.getProperty(PR_INTERNET_CPID)?.value, undefined)
  return typeof cp === 'number' ? cp : undefined
}

function propString(m: IPSTMessage, key: number): string {
  const value = safe(() => m.getProperty(key)?.value, undefined)
  if (typeof value === 'string') return value
  if (value instanceof ArrayBuffer && value.byteLength > 0) return decodeBinary(value, bodyCodepage(m))
  return ''
}

const CONTROL_WORD = /^\\([a-zA-Z]+)(-?\d+)? ?/

/**
 * De-encapsulate Outlook compressed-RTF (already decompressed via `bodyRTF`).
 * Recovers the original HTML for `\fromhtml` mail (MS-OXRTFEX), or best-effort
 * text for `\fromtext` / plain RTF.
 */
function deEncapsulateRtf(rtf: string, cp?: number): { html: string; text: string } {
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

  const flushHex = () => {
    if (!hex.length) return
    if (st.htmltag || (!st.htmlrtf && !st.suppress)) {
      try {
        out.push(new TextDecoder(codepageToLabel(cp), { fatal: false }).decode(new Uint8Array(hex)))
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
    if (skipChars > 0 && c !== '{' && c !== '}' && c !== '\\') {
      skipChars--
      i++
      continue
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
        case 'htmlrtf':
          st = { ...st, htmlrtf: param !== 0 }
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
  let text = safe(() => m.body, '') || propString(m, PR_BODY)
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
function parseOneOffMember(bytes: Uint8Array): { name: string; email: string } | null {
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
    const s = new TextDecoder('utf-8').decode(bytes.subarray(off, end))
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
      const parsed = buf ? parseOneOffMember(buf) : null
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
          const at = attachments.findIndex((x) => x.index === p7mIdx)
          if (at !== -1) attachments.splice(at, 1)
        } else if (res.kind === 'encrypted') {
          smimeNote =
            "This is an encrypted S/MIME message. It cannot be read without the recipient's private key."
        }
      }
    }
  }
  const finalHtml = bodies.html || smimeBody?.html || null
  const finalText = bodies.text || tnefBody || smimeBody?.text || smimeNote || null

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
    subject: safe(() => m.subject, '') || '(no subject)',
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
    contact: kind === 'contact' ? buildContactCard(m) : undefined,
    appointment: kind === 'appointment' ? buildAppointmentCard(m) : undefined,
    distlist: kind === 'distlist' ? buildDistListCard(m) : undefined,
    task: kind === 'task' ? buildTaskCard(m) : undefined,
    journal: kind === 'journal' ? buildJournalCard(m) : undefined,
  }
}

const api = {
  async ping(): Promise<'pong'> {
    return 'pong'
  },

  /** Open a PST/OST File, walk its folder tree, and return a serializable index. */
  async openSource(sourceId: string, file: File): Promise<SourceIndex> {
    sources.delete(sourceId)

    const pstFile = await openPst(makeReader(file))
    const entry: SourceEntry = {
      file: pstFile,
      folders: new Map(),
      messages: new Map(),
      attachments: new Map(),
      ocr: new Map(),
      bodyImageCount: new Map(),
      searchIds: new Set(),
      tnef: new Map(),
    }
    sources.set(sourceId, entry)

    const root = await pstFile.getRootFolder()
    const rootNode = await buildFolderTree(root, entry)

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
    const topName = await safeAsync(
      async () => (await pstFile.getTopOfOutlookDataFile()).displayName,
      '',
    )
    const ownerName = [storeName, topName].find((n) => n && !isGenericStoreName(n)) ?? ''

    return {
      rootFolder: rootNode,
      totalMessages,
      suggestedLabel: ownerName || prettyFileName(file.name),
    }
  },

  /** Load metadata for every message in one folder. */
  async getFolderMessages(sourceId: string, folderId: string): Promise<MessageMeta[]> {
    const entry = sources.get(sourceId)
    if (!entry) return []
    const folder = entry.folders.get(folderId)
    if (!folder) return []

    const emails = await safeAsync(() => folder.getEmails(), [] as IPSTMessage[])
    const metas: MessageMeta[] = []
    for (const m of emails) {
      try {
        entry.messages.set(String(m.primaryNodeId), m)
        metas.push(toMeta(m, folderId))
      } catch {
        // Skip an individual unreadable message rather than failing the folder.
      }
    }
    return metas
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
    const list = entry.attachments.get(messageId)
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

  /**
   * Build the full-text search index for a source in the background.
   * Walks every folder, indexing subject/from/to/body/attachment-names, and
   * warms the message + attachment caches as a side effect.
   */
  async indexSource(
    sourceId: string,
    onProgress?: (done: number, total: number) => void,
  ): Promise<void> {
    const entry = sources.get(sourceId)
    if (!entry) return

    let total = 0
    for (const folder of entry.folders.values()) total += safe(() => folder.contentCount, 0)
    let done = 0

    for (const [folderId, folder] of entry.folders) {
      if (!sources.has(sourceId)) return // source removed mid-index
      const emails = await safeAsync(() => folder.getEmails(), [])
      const docs: SearchDoc[] = []
      for (const m of emails) {
        const msgId = String(m.primaryNodeId)
        entry.messages.set(msgId, m)
        const id = `${sourceId}:${msgId}`
        done++
        if (searchIndex.has(id)) continue
        try {
          const doc = await buildSearchDoc(sourceId, folderId, msgId, m, entry)
          docs.push(doc)
          searchDocs.set(id, doc)
          entry.searchIds.add(id)
        } catch {
          // skip an unreadable message
        }
      }
      // If the source was closed while reading this folder, drop what we staged
      // instead of leaving orphaned docs in the shared search index.
      if (!sources.has(sourceId)) {
        for (const d of docs) searchDocs.delete(d.id)
        return
      }
      if (docs.length) searchIndex.addAll(docs)
      onProgress?.(done, total)
    }
    onProgress?.(done, total)
  },

  /** Fuzzy full-text search across all indexed sources. */
  async search(query: string, limit = 100): Promise<SearchHit[]> {
    const q = query.trim()
    if (!q) return []
    // Terms with a digit (numbers, ids, reference codes) are specific, so match
    // them exactly. Fuzzy matching on an id finds near-misses that are rarely
    // wanted and, worse, do not contain the typed text so nothing highlights.
    // Plain words stay fuzzy for typo tolerance.
    const results = searchIndex.search(q, {
      combineWith: 'AND',
      fuzzy: (term) => (/\d/.test(term) ? false : 0.2),
    })
    return results.slice(0, limit).map((r) => ({
      sourceId: r.sourceId as string,
      messageId: r.messageId as string,
      folderId: r.folderId as string,
      subject: r.subject as string,
      from: r.from as string,
      date: (r.date as number | null) ?? null,
      hasAttachments: Boolean(r.hasAttachments),
      score: r.score,
    }))
  },

  /** Every image to OCR across a source: image attachments plus data: body images. */
  async listOcrImages(sourceId: string): Promise<OcrTarget[]> {
    const entry = sources.get(sourceId)
    if (!entry) return []
    const out: OcrTarget[] = []
    for (const [messageId, list] of entry.attachments) {
      list.forEach((a, index) => {
        if (safe(() => a.attachMethod, 0) !== Consts.ATTACH_BY_VALUE) return
        const name = attachmentName(a, index, false)
        if (isImageAttachment(name, safe(() => a.mimeTag, ''))) {
          out.push({ messageId, kind: 'att', ref: index })
        }
      })
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
    for (const id of entry.searchIds) searchDocs.delete(id)
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
    }
    await safeAsync(() => entry.file.close(), undefined)
  },
}

export type PstWorkerApi = typeof api

Comlink.expose(api)
