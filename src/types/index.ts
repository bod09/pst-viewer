/** Types that cross the Web Worker boundary — must be plain & serializable. */

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
  size: number
}

export interface SourceIndex {
  rootFolder: FolderNode
  totalMessages: number
  /** Best-effort human label for the mailbox (owner name, etc.). */
  suggestedLabel: string
  ownerName: string
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
  /** This attachment is itself an embedded email. */
  isEmbeddedMessage: boolean
}

/** Raw attachment bytes plus resolved name/mime, fetched on demand. */
export interface AttachmentData {
  name: string
  mime: string
  data: ArrayBuffer
}

/** Full content of a single message, fetched lazily when it is opened. */
export interface MessageContent {
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
}

/** Result of opening an embedded (nested) email attachment. */
export interface EmbeddedMessageResult {
  /** Synthetic message id under which the nested message is registered. */
  id: string
  content: MessageContent
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
