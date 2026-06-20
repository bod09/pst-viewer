/** Types that cross the Web Worker boundary; must be plain & serializable. */

export interface FolderNode {
  id: string
  name: string
  containerClass: string
  /** Message count as reported by the store (instant, may be approximate). */
  messageCount: number
  children: FolderNode[]
}

export interface MessageMeta {
  id: string
  folderId: string
  subject: string
  fromName: string
  fromEmail: string
  to: string
  /** Epoch ms (delivery time, falling back to submit time), or null. */
  date: number | null
  hasAttachments: boolean
  isRead: boolean
  messageClass: string
}

export interface SourceIndex {
  rootFolder: FolderNode
  totalMessages: number
  /** Best-effort human label for the mailbox (owner name, etc.). */
  suggestedLabel: string
}

export interface RecipientInfo {
  name: string
  email: string
}

/** An inline image attachment (referenced from the HTML body via `cid:`). */
export interface InlineImage {
  cid: string
  mime: string
  data: ArrayBuffer
}

export interface AttachmentMeta {
  /** Stable index within the message's attachment table. */
  index: number
  name: string
  size: number
  /** MIME from the PST (mimeTag); may be empty. */
  mime: string
  /** Referenced inline from the HTML body (has a Content-ID). */
  isInline: boolean
  /** Content-ID (without angle brackets) for inline images, if any. */
  cid?: string
  /** This attachment is itself an embedded email. */
  isEmbeddedMessage: boolean
}

/** Raw attachment bytes plus resolved name/mime, fetched on demand. */
export interface AttachmentData {
  name: string
  mime: string
  data: ArrayBuffer
}

/** What kind of Outlook item a message is, so non-email items render properly. */
export type ItemKind = 'email' | 'contact' | 'appointment' | 'distlist'

/** A contact (IPM.Contact) rendered as a card instead of an email. */
export interface ContactCard {
  fullName: string
  emails: { label: string; address: string }[]
  phones: { label: string; value: string }[]
  company: string
  jobTitle: string
  department: string
  addresses: { label: string; value: string }[]
  website: string
  im: string
  birthday: number | null
}

/** A calendar appointment / meeting (IPM.Appointment) rendered as a card. */
export interface AppointmentCard {
  location: string
  start: number | null
  end: number | null
  allDay: boolean
  organizer: string
  requiredAttendees: string
  optionalAttendees: string
  recurrence: string
}

/** A distribution list / contact group (IPM.DistList) rendered as a card. */
export interface DistListCard {
  name: string
  members: { name: string; email: string }[]
}

/** Full content of a single message, fetched lazily when it is opened. */
export interface MessageContent {
  /** Item type, so contacts/appointments can render as cards instead of email. */
  itemKind: ItemKind
  subject: string
  fromName: string
  fromEmail: string
  to: RecipientInfo[]
  cc: RecipientInfo[]
  bcc: RecipientInfo[]
  date: number | null
  /** Raw (unsanitized) HTML body, or null. Sanitized on the main thread. */
  html: string | null
  /** Plain-text body, or null. */
  text: string | null
  inlineImages: InlineImage[]
  attachments: AttachmentMeta[]
  /** Raw RFC822 transport headers, if present. */
  headers: string
  /** Present when itemKind is 'contact'. */
  contact?: ContactCard
  /** Present when itemKind is 'appointment'. */
  appointment?: AppointmentCard
  /** Present when itemKind is 'distlist'. */
  distlist?: DistListCard
}

/** Result of opening an embedded (nested) email attachment. */
export interface EmbeddedMessageResult {
  /** Synthetic message id under which the nested message is registered. */
  id: string
  content: MessageContent
}

/** An image to run OCR over: either a real attachment or a data: image in the body. */
export interface OcrTarget {
  messageId: string
  kind: 'att' | 'body'
  /** Attachment index, or position among the body's data: images. */
  ref: number
}

/** Which images of an open message contain the search text (via OCR). */
export interface OcrMatchResult {
  /** Attachment indexes (chips + cid inline images). */
  attachmentIndexes: number[]
  /** Positions among the body's data: images (in document order). */
  bodyImageIndexes: number[]
}

/** A single full-text search match. */
export interface SearchHit {
  sourceId: string
  messageId: string
  folderId: string
  subject: string
  from: string
  date: number | null
  hasAttachments: boolean
  score: number
}
