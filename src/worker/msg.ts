import MsgReaderImport, { type FieldsData } from '@kenjiuno/msgreader'
import type MsgReaderType from '@kenjiuno/msgreader'

// The package is CJS; depending on the bundler's interop the default import is
// either the class itself or the module namespace wrapping it.
type MsgReaderCtor = new (buffer: ArrayBuffer | DataView) => MsgReaderType
const MsgReader: MsgReaderCtor =
  ((MsgReaderImport as unknown as { default?: MsgReaderCtor }).default ??
    MsgReaderImport) as MsgReaderCtor
type MsgReader = MsgReaderType
import { decompressRTF } from '@kenjiuno/decompressrtf'
import {
  Consts,
  type IPSTAttachment,
  type IPSTFolder,
  type IPSTMessage,
} from '@hiraokahypertools/pst-extractor'
import type { AppointmentCard, ContactCard } from '../types'

/**
 * Outlook `.msg` support: parse a standalone .msg file (CFB/MAPI, via
 * MsgReader) and wrap the result in objects that present the same surface as
 * pst-extractor's message/folder/attachment. The rest of the worker (bodies,
 * search indexing, OCR, TNEF/S-MIME unpacking, EML export, nested messages)
 * then works on .msg items unchanged.
 *
 * Only the members the worker actually reads are implemented; the adapters are
 * cast to the pst-extractor interfaces, and every access site already guards
 * with safe()/try-catch, so missing PST-only members degrade gracefully.
 */

/** Marker + payload so the worker can build cards from raw .msg fields. */
export interface MsgBacked {
  __msgFields: FieldsData
}

function parseDate(s: string | undefined): Date | null {
  if (!s) return null
  const d = new Date(s)
  return Number.isNaN(d.getTime()) ? null : d
}

/** rawProps lookup by numeric property id (HIWORD of the 8-hex-char tag). */
function propValue(fields: FieldsData, id: number): unknown {
  const want = id.toString(16).padStart(4, '0')
  for (const p of fields.rawProps ?? []) {
    if (p.propertyTag?.slice(0, 4) === want && p.value !== undefined) {
      // The worker's property readers expect binary values as ArrayBuffer.
      if (p.value instanceof Uint8Array) {
        return p.value.slice().buffer
      }
      return p.value
    }
  }
  return undefined
}

class MsgAttachmentAdapter {
  constructor(
    private reader: MsgReader,
    private fields: FieldsData,
    private parent: MsgMessageAdapter,
  ) {}

  private bytes: ArrayBuffer | null | undefined

  get longFilename(): string {
    return this.fields.fileName ?? ''
  }
  get filename(): string {
    return this.fields.fileNameShort ?? ''
  }
  get displayName(): string {
    return this.fields.name ?? ''
  }
  get attachMethod(): number {
    return this.fields.innerMsgContent ? Consts.ATTACH_EMBEDDED_MSG : Consts.ATTACH_BY_VALUE
  }
  get contentId(): string {
    return this.fields.pidContentId ?? ''
  }
  get isAttachmentInvisibleInHtml(): boolean {
    return this.fields.attachmentHidden === true
  }
  get mimeTag(): string {
    return this.fields.attachMimeTag ?? ''
  }
  get filesize(): number {
    return this.fields.contentLength ?? 0
  }
  get size(): number {
    return this.filesize
  }
  get fileData(): ArrayBuffer | undefined {
    if (this.bytes === undefined) {
      try {
        const content = this.reader.getAttachment(this.fields).content
        this.bytes = content.slice().buffer
      } catch {
        this.bytes = null
      }
    }
    return this.bytes ?? undefined
  }
  async getEmbeddedPSTMessage(): Promise<IPSTMessage | null> {
    const inner = this.fields.innerMsgContentFields
    if (!inner) return null
    return asPstMessage(new MsgMessageAdapter(this.reader, inner, `${this.parent.nodeId}.inner`))
  }
}

class MsgMessageAdapter implements MsgBacked {
  constructor(
    private reader: MsgReader,
    private fields: FieldsData,
    readonly nodeId: string,
  ) {}

  get __msgFields(): FieldsData {
    return this.fields
  }

  private rtf: string | null | undefined

  get primaryNodeId(): string {
    return this.nodeId
  }
  get subject(): string {
    return this.fields.subject ?? this.fields.normalizedSubject ?? ''
  }
  get senderName(): string {
    return this.fields.senderName ?? ''
  }
  get senderEmailAddress(): string {
    return this.fields.senderSmtpAddress ?? this.fields.senderEmail ?? ''
  }
  get sentRepresentingName(): string {
    return ''
  }
  get sentRepresentingEmailAddress(): string {
    return this.fields.sentRepresentingSmtpAddress ?? ''
  }
  private recips(type: 'to' | 'cc' | 'bcc'): FieldsData[] {
    return (this.fields.recipients ?? []).filter((r) => (r.recipType ?? 'to') === type)
  }
  get displayTo(): string {
    return this.recips('to')
      .map((r) => r.name || r.email || '')
      .filter(Boolean)
      .join('; ')
  }
  get displayCC(): string {
    return this.recips('cc')
      .map((r) => r.name || r.email || '')
      .filter(Boolean)
      .join('; ')
  }
  get messageDeliveryTime(): Date | null {
    return parseDate(this.fields.messageDeliveryTime)
  }
  get clientSubmitTime(): Date | null {
    // Fall back to the CFB creation time so drafts still get a date.
    return parseDate(this.fields.clientSubmitTime) ?? parseDate(this.fields.creationTime)
  }
  get hasAttachments(): boolean {
    return (this.fields.attachments ?? []).length > 0
  }
  get isRead(): boolean {
    const flags = this.fields.messageFlags
    return typeof flags === 'number' ? (flags & 1) !== 0 : true
  }
  get messageClass(): string {
    return this.fields.messageClass ?? 'IPM.Note'
  }
  get body(): string {
    return this.fields.body ?? ''
  }
  get bodyHTML(): string {
    return this.fields.bodyHtml ?? ''
  }
  get bodyRTF(): string {
    if (this.rtf === undefined) {
      this.rtf = null
      const packed = this.fields.compressedRtf
      if (packed && packed.length > 0) {
        try {
          const out = Uint8Array.from(decompressRTF(Array.from(packed)))
          // RTF is 8-bit ASCII-compatible; non-ASCII travels as \'xx escapes.
          this.rtf = new TextDecoder('windows-1252', { fatal: false }).decode(out)
        } catch {
          this.rtf = null
        }
      }
    }
    return this.rtf ?? ''
  }
  get transportMessageHeaders(): string {
    return this.fields.headers ?? ''
  }
  get colorCategories(): string[] {
    return [] // MsgReader does not decode multi-value string properties
  }
  get importance(): number {
    const v = propValue(this.fields, 0x0017) // PR_IMPORTANCE
    return typeof v === 'number' ? v : 1
  }
  get sensitivity(): number {
    const v = propValue(this.fields, 0x0036) // PR_SENSITIVITY
    return typeof v === 'number' ? v : 0
  }
  get priority(): number {
    const v = propValue(this.fields, 0x0026) // PR_PRIORITY
    return typeof v === 'number' ? v : 0
  }
  getProperty(key: number): { value: unknown } | undefined {
    const value = propValue(this.fields, key)
    return value === undefined ? undefined : { value }
  }
  async getRecipients(): Promise<unknown[]> {
    return (this.fields.recipients ?? []).map((r) => ({
      displayName: r.name ?? '',
      smtpAddress: r.smtpAddress ?? r.email ?? '',
      emailAddress: r.email ?? '',
      recipientType:
        r.recipType === 'cc' ? Consts.MAPI_CC : r.recipType === 'bcc' ? Consts.MAPI_BCC : Consts.MAPI_TO,
    }))
  }
  async getAttachments(): Promise<MsgAttachmentAdapter[]> {
    return (this.fields.attachments ?? []).map((a) => new MsgAttachmentAdapter(this.reader, a, this))
  }
}

class MsgFolderAdapter {
  constructor(
    readonly nodeId: string,
    private name: string,
    private emails: MsgMessageAdapter[],
    private cls: string,
  ) {}

  get primaryNodeId(): string {
    return this.nodeId
  }
  get displayName(): string {
    return this.name
  }
  get containerClass(): string {
    return this.cls
  }
  get contentCount(): number {
    return this.emails.length
  }
  async getSubFolders(): Promise<IPSTFolder[]> {
    return []
  }
  async getEmails(): Promise<IPSTMessage[]> {
    return this.emails.map(asPstMessage)
  }
  getProperty(): undefined {
    return undefined
  }
}

const asPstMessage = (m: MsgMessageAdapter) => m as unknown as IPSTMessage
export const asPstAttachment = (a: MsgAttachmentAdapter) => a as unknown as IPSTAttachment

// Default ANSI code page for a message language (PidTagMessageLocaleId), for
// messages that don't record PidTagMessageCodepage directly.
const LOCALE_ANSI_CP: Record<number, number> = {
  1041: 932, // Japanese
  1042: 949, // Korean
  2052: 936, // Chinese (simplified)
  1028: 950, // Chinese (traditional)
  1049: 1251, 1058: 1251, 1026: 1251, // Russian / Ukrainian / Bulgarian
  1032: 1253, // Greek
  1037: 1255, // Hebrew
  1025: 1256, // Arabic
  1054: 874, // Thai
  1055: 1254, // Turkish
  1029: 1250, 1038: 1250, 1045: 1250, 1048: 1250, 1051: 1250, 1060: 1250, // Central European
  1061: 1257, 1062: 1257, 1063: 1257, // Baltic
}

// Transport-only internet encodings mapped to the ANSI code page actually used
// for stored 8-bit strings (e.g. iso-2022-jp mail stores Shift-JIS text).
const NET_ANSI_CP: Record<number, number> = {
  50220: 932, 50221: 932, 50222: 932, 51932: 932,
  51949: 949,
  52936: 936,
}

/** Best guess at the code page of a message's PT_STRING8 properties. */
function ansiCodepageOf(fields: FieldsData): number | undefined {
  if (typeof fields.messageCodepage === 'number') return fields.messageCodepage
  const viaLocale =
    typeof fields.messageLocaleId === 'number' ? LOCALE_ANSI_CP[fields.messageLocaleId] : undefined
  if (viaLocale !== undefined) return viaLocale
  const net = fields.internetCodepage
  if (typeof net === 'number') return NET_ANSI_CP[net] ?? net
  return undefined
}

/** Any 8-bit ("ANSI", PT_STRING8) string property anywhere in the message? */
function hasAnsiStrings(fields: FieldsData): boolean {
  if ((fields.rawProps ?? []).some((p) => p.propertyTag?.endsWith('001e'))) return true
  const subs = [...(fields.recipients ?? []), ...(fields.attachments ?? [])]
  return subs.some((f) => (f.rawProps ?? []).some((p) => p.propertyTag?.endsWith('001e')))
}

/** Parse one .msg file into a PST-shaped message adapter. Throws if unreadable. */
export function parseMsg(data: ArrayBuffer, nodeId: string): IPSTMessage {
  const reader = new MsgReader(data)
  reader.parserConfig = { includeRawProps: true }
  const fields = reader.getFileData()
  if (fields.error) throw new Error(fields.error)

  // Old (non-Unicode) messages store strings as 8-bit text in the message's
  // own code page; without the hint msgreader decodes them as Latin-1 and
  // CJK/Cyrillic content turns to mojibake. Detect and re-parse with the hint
  // (decoded by our TextDecoder shim, see lib/iconv-lite-shim.ts).
  const cp = ansiCodepageOf(fields)
  if (typeof cp === 'number' && cp !== 1252 && hasAnsiStrings(fields)) {
    const retry = new MsgReader(data)
    retry.parserConfig = { includeRawProps: true, ansiEncoding: String(cp) }
    const refields = retry.getFileData()
    if (!refields.error) return asPstMessage(new MsgMessageAdapter(retry, refields, nodeId))
  }
  return asPstMessage(new MsgMessageAdapter(reader, fields, nodeId))
}

/** A synthetic single folder holding standalone .msg messages. */
export function createMsgFolder(
  id: string,
  name: string,
  emails: IPSTMessage[],
  containerClass = 'IPF.Note',
): IPSTFolder {
  return new MsgFolderAdapter(
    id,
    name,
    emails as unknown as MsgMessageAdapter[],
    containerClass,
  ) as unknown as IPSTFolder
}

/** The raw .msg fields behind a message, when it is .msg-backed. */
export function msgFieldsOf(m: IPSTMessage): FieldsData | undefined {
  return (m as unknown as Partial<MsgBacked>).__msgFields
}

/** Contact card straight from .msg fields (PST named-property path can't run). */
/**
 * Contact details that msgreader does not surface as named fields.
 *
 * Its typed output stops at email1 and a couple of addresses, so the rest is
 * read straight from the raw properties: named ones (the email slots) by
 * their property id, fixed ones (birthday, extra phones, home address) by
 * their tag. Without this a .msg contact shows noticeably less than the same
 * contact inside a PST.
 */
interface RawLike {
  propertyTag?: string
  propertyLid?: string
  value?: string | Uint8Array
}

function rawText(f: FieldsData, matches: (p: RawLike) => boolean): string {
  const props = (f as unknown as { rawProps?: RawLike[] }).rawProps
  if (!props) return ''
  for (const p of props) {
    if (!matches(p)) continue
    const v = p.value
    if (typeof v === 'string' && v.trim()) return v.trim()
  }
  return ''
}

/** A fixed property, matched on the id half of its tag (e.g. "3a42"). */
const byTag = (f: FieldsData, id: string): string =>
  rawText(f, (p) => (p.propertyTag ?? '').toLowerCase().startsWith(id))

/** A named property, matched on its id (e.g. "00008093" for email2). */
const byLid = (f: FieldsData, lid: string): string =>
  rawText(f, (p) => (p.propertyLid ?? '').toLowerCase() === lid)

/** Join the parts of an address the way Outlook composes them. */
const joinAddress = (...parts: string[]): string => {
  const kept = parts.map((p) => p.trim()).filter(Boolean)
  return kept.length ? kept.join('\n') : ''
}

export function msgContactCard(f: FieldsData, subject: string): ContactCard {
  const fullName =
    f.fileUnder ||
    [f.givenName, f.middleName, f.surname].filter(Boolean).join(' ') ||
    subject
  const emails: ContactCard['emails'] = []
  const pushEmail = (address: string, label: string) => {
    if (address) emails.push({ label: label || 'Email', address })
  }
  pushEmail(f.email1EmailAddress ?? '', f.email1DisplayName ?? '')
  pushEmail(byLid(f, '00008093'), byLid(f, '00008090'))
  pushEmail(byLid(f, '000080a3'), byLid(f, '000080a0'))

  const phones: ContactCard['phones'] = []
  const pushPhone = (value: string, label: string) => {
    if (value) phones.push({ label, value })
  }
  pushPhone(f.businessTelephoneNumber ?? '', 'Business')
  pushPhone(f.mobileTelephoneNumber ?? '', 'Mobile')
  pushPhone(f.homeTelephoneNumber ?? '', 'Home')
  pushPhone(byTag(f, '3a1f'), 'Other')
  pushPhone(byTag(f, '3a57'), 'Company')
  pushPhone(f.businessFaxNumber ?? '', 'Business fax')

  const addresses: ContactCard['addresses'] = []
  const pushAddress = (value: string, label: string) => {
    if (value) addresses.push({ label, value })
  }
  pushAddress(f.workAddress || f.postalAddress || '', f.workAddress ? 'Work' : 'Address')
  pushAddress(
    joinAddress(byTag(f, '3a5d'), byTag(f, '3a59'), byTag(f, '3a5c'), byTag(f, '3a5b'), byTag(f, '3a5a')),
    'Home',
  )
  pushAddress(
    joinAddress(byTag(f, '3a63'), byTag(f, '3a5f'), byTag(f, '3a62'), byTag(f, '3a61'), byTag(f, '3a60')),
    'Other',
  )

  const birthdayRaw = byTag(f, '3a42')
  const birthday = birthdayRaw ? Date.parse(birthdayRaw) : NaN

  return {
    fullName,
    emails,
    phones,
    company: f.companyName ?? '',
    jobTitle: f.title ?? '',
    department: f.departmentName ?? f.department ?? '',
    addresses,
    website: f.businessHomePage || byTag(f, '3a50') || '',
    im: f.instMsg ?? '',
    birthday: Number.isNaN(birthday) ? null : birthday,
  }
}

/** Appointment card straight from .msg fields. */
export function msgAppointmentCard(f: FieldsData, organizer: string): AppointmentCard {
  const to: string[] = []
  const cc: string[] = []
  for (const r of f.recipients ?? []) {
    const label = r.name || r.email || ''
    if (!label) continue
    if (r.recipType === 'cc') cc.push(label)
    else to.push(label)
  }
  return {
    location: f.apptLocation ?? f.location ?? '',
    start: parseDate(f.apptStartWhole)?.getTime() ?? null,
    end: parseDate(f.apptEndWhole)?.getTime() ?? null,
    allDay: false,
    organizer,
    requiredAttendees: to.join('; '),
    optionalAttendees: cc.join('; '),
    recurrence: '',
  }
}
