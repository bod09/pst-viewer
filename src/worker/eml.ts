import PostalMime, { type Address, type Attachment, type Email, type Mailbox } from 'postal-mime'
import { Consts, type IPSTMessage } from '@hiraokahypertools/pst-extractor'

/**
 * RFC822 `.eml` support: parse with postal-mime and wrap the result in objects
 * presenting the pst-extractor message surface, exactly like the .msg adapters
 * in msg.ts, so the whole worker pipeline works on .eml unchanged.
 */

/** Flatten address groups into plain mailboxes. */
function mailboxes(list: Address[] | undefined): Mailbox[] {
  const out: Mailbox[] = []
  for (const a of list ?? []) {
    if (a.group) out.push(...a.group)
    else out.push(a)
  }
  return out
}

const displayOf = (m: Mailbox): string => m.name || m.address || ''

function toArrayBuffer(content: Attachment['content']): ArrayBuffer {
  if (typeof content === 'string') {
    const b = new TextEncoder().encode(content)
    return b.buffer as ArrayBuffer
  }
  if (content instanceof Uint8Array) {
    return content.slice().buffer as ArrayBuffer
  }
  return content
}

class EmlAttachmentAdapter {
  constructor(
    private a: Attachment,
    private parent: EmlMessageAdapter,
    private index: number,
  ) {}

  private bytes: ArrayBuffer | undefined

  get longFilename(): string {
    return this.a.filename ?? ''
  }
  get filename(): string {
    return this.a.filename ?? ''
  }
  get displayName(): string {
    return this.a.filename ?? (this.isRfc822 ? 'Attached message' : '')
  }
  private get isRfc822(): boolean {
    return this.a.mimeType.toLowerCase() === 'message/rfc822'
  }
  get attachMethod(): number {
    return this.isRfc822 ? Consts.ATTACH_EMBEDDED_MSG : Consts.ATTACH_BY_VALUE
  }
  get contentId(): string {
    return (this.a.contentId ?? '').replace(/^<+|>+$/g, '').trim()
  }
  get isAttachmentInvisibleInHtml(): boolean {
    return this.a.related === true
  }
  get mimeTag(): string {
    return this.a.mimeType
  }
  get filesize(): number {
    return this.fileData?.byteLength ?? 0
  }
  get size(): number {
    return this.filesize
  }
  get fileData(): ArrayBuffer | undefined {
    if (this.bytes === undefined) this.bytes = toArrayBuffer(this.a.content)
    return this.bytes
  }
  async getEmbeddedPSTMessage(): Promise<IPSTMessage | null> {
    if (!this.isRfc822) return null
    const raw = this.fileData
    if (!raw || raw.byteLength === 0) return null
    try {
      return await parseEml(raw, `${this.parent.nodeId}.inner${this.index}`)
    } catch {
      return null
    }
  }
}

class EmlMessageAdapter {
  constructor(
    private email: Email,
    readonly nodeId: string,
  ) {}

  get primaryNodeId(): string {
    return this.nodeId
  }
  get subject(): string {
    return this.email.subject ?? ''
  }
  private get fromBox(): Mailbox | undefined {
    return mailboxes(this.email.from ? [this.email.from] : undefined)[0]
  }
  get senderName(): string {
    return this.fromBox?.name ?? ''
  }
  get senderEmailAddress(): string {
    return this.fromBox?.address ?? ''
  }
  get sentRepresentingName(): string {
    return ''
  }
  get sentRepresentingEmailAddress(): string {
    return ''
  }
  get displayTo(): string {
    return mailboxes(this.email.to).map(displayOf).filter(Boolean).join('; ')
  }
  get displayCC(): string {
    return mailboxes(this.email.cc).map(displayOf).filter(Boolean).join('; ')
  }
  get messageDeliveryTime(): Date | null {
    const d = this.email.date ? new Date(this.email.date) : null
    return d && !Number.isNaN(d.getTime()) ? d : null
  }
  get clientSubmitTime(): Date | null {
    return null
  }
  get hasAttachments(): boolean {
    return this.email.attachments.some((a) => a.related !== true)
  }
  get isRead(): boolean {
    return true
  }
  get messageClass(): string {
    return 'IPM.Note'
  }
  get body(): string {
    return this.email.text ?? ''
  }
  get bodyHTML(): string {
    return this.email.html ?? ''
  }
  get bodyRTF(): string {
    return ''
  }
  get transportMessageHeaders(): string {
    return this.email.headerLines.map((h) => h.line).join('\r\n')
  }
  get colorCategories(): string[] {
    return []
  }
  private header(key: string): string {
    return (this.email.headers.find((h) => h.key === key)?.value ?? '').toLowerCase()
  }
  get importance(): number {
    const imp = this.header('importance')
    if (imp.startsWith('high')) return 2
    if (imp.startsWith('low')) return 0
    const prio = parseInt(this.header('x-priority'), 10)
    if (prio === 1 || prio === 2) return 2
    if (prio === 4 || prio === 5) return 0
    return 1
  }
  get sensitivity(): number {
    const s = this.header('sensitivity')
    if (s.startsWith('personal')) return 1
    if (s.startsWith('private')) return 2
    if (s.startsWith('company-confidential') || s.startsWith('confidential')) return 3
    return 0
  }
  get priority(): number {
    return 0
  }
  getProperty(): undefined {
    return undefined
  }
  async getRecipients(): Promise<unknown[]> {
    const make = (list: Address[] | undefined, type: number) =>
      mailboxes(list).map((m) => ({
        displayName: m.name || '',
        smtpAddress: m.address || '',
        emailAddress: m.address || '',
        recipientType: type,
      }))
    return [
      ...make(this.email.to, Consts.MAPI_TO),
      ...make(this.email.cc, Consts.MAPI_CC),
      ...make(this.email.bcc, Consts.MAPI_BCC),
    ]
  }
  async getAttachments(): Promise<EmlAttachmentAdapter[]> {
    return this.email.attachments.map((a, i) => new EmlAttachmentAdapter(a, this, i))
  }
}

/** Parse one .eml (RFC822) file into a PST-shaped message adapter. */
export async function parseEml(data: ArrayBuffer, nodeId: string): Promise<IPSTMessage> {
  const email = await PostalMime.parse(data, {
    // Keep nested message/rfc822 parts as openable attachments (like Outlook),
    // and hand attachment bodies over as ArrayBuffers.
    rfc822Attachments: true,
    attachmentEncoding: 'arraybuffer',
  })
  // postal-mime accepts nearly any bytes; require some evidence of a real
  // message so garbage is reported as unreadable instead of shown empty.
  const plausible =
    email.headerLines.length > 0 &&
    Boolean(email.subject || email.from || email.date || email.to?.length || email.messageId)
  if (!plausible) throw new Error('not an RFC822 message')
  return new EmlMessageAdapter(email, nodeId) as unknown as IPSTMessage
}

/** The CFB magic that starts every .msg file (an OLE compound document). */
export function isCfbFile(data: ArrayBuffer): boolean {
  const b = new Uint8Array(data, 0, Math.min(8, data.byteLength))
  return (
    b.length === 8 &&
    b[0] === 0xd0 && b[1] === 0xcf && b[2] === 0x11 && b[3] === 0xe0 &&
    b[4] === 0xa1 && b[5] === 0xb1 && b[6] === 0x1a && b[7] === 0xe1
  )
}
