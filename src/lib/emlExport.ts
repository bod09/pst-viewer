import type { MessageContent, RecipientInfo } from '../types'

/** A non-inline attachment's bytes, fetched on demand for the export. */
export interface EmlAttachment {
  name: string
  mime: string
  data: ArrayBuffer
}

function base64(bytes: ArrayBuffer | Uint8Array): string {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  const chunks: string[] = []
  const size = 0x8000
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(String.fromCharCode(...arr.subarray(i, i + size)))
  }
  return btoa(chunks.join(''))
}

function base64Text(s: string): string {
  return base64(new TextEncoder().encode(s))
}

/** Wrap base64 to 76-char lines, as MIME requires. */
function fold(b64: string): string {
  return b64.replace(/.{1,76}/g, '$&\r\n')
}

const utf8 = new TextEncoder()

/** Short printable ASCII that no reader would take for an encoded word. */
const isPlain = (s: string): boolean => /^[\x20-\x7e]*$/.test(s) && !s.includes('=?') && s.length <= 800

/**
 * A header value as it may be written: plain when it is short printable
 * ASCII, otherwise as RFC 2047 encoded words.
 *
 * Text that contains "=?" is encoded even when it is plain ASCII, because a
 * reader would take it for an encoded word and show something other than what
 * was there. An encoded word may be at most 75 characters, so long text
 * becomes several, one to a line, split between characters and never inside
 * one; that also keeps every line well inside the 998 a header line may be.
 */
function encodeWord(s: string): string {
  if (isPlain(s)) return s
  const words: string[] = []
  let chunk = ''
  let bytes = 0
  for (const ch of s) {
    const n = utf8.encode(ch).length
    // 39 bytes are 52 base64 characters, 64 with the "=?UTF-8?B?" and "?=",
    // which leaves room on the first line for the header's own name.
    if (bytes + n > 39) {
      words.push(chunk)
      chunk = ''
      bytes = 0
    }
    chunk += ch
    bytes += n
  }
  words.push(chunk)
  return words.map((w) => `=?UTF-8?B?${base64Text(w)}?=`).join('\r\n ')
}

/**
 * A MIME type as it may stand in a header. The type comes from the mail file,
 * so anything that is not plainly "type/subtype" is treated as unknown rather
 * than written out, where a line break in it would start headers of its own.
 */
function mimeType(s: string): string {
  const type = (s || '').split(';')[0].trim()
  return /^[\w.+-]+\/[\w.+-]+$/.test(type) ? type : 'application/octet-stream'
}

/**
 * A value safe to place inside a quoted MIME parameter. A filename carrying a
 * quote, a semicolon or a line break would otherwise close the parameter and
 * let the rest be read as headers, which matters when the exported file is
 * evidence someone else will open.
 */
function quotedParam(s: string): string {
  const plain = s.replace(/[\r\n]+/g, ' ')
  if (!/^[\x20-\x7e]*$/.test(plain) || plain.includes('=?')) return `=?UTF-8?B?${base64Text(plain)}?=`
  return plain.replace(/["\\]/g, '_')
}

/** Strip anything that could break out of a header line, or out of the angle
 *  brackets around an address or a content id. */
const headerSafe = (s: string): string => s.replace(/[\u0000-\u001f\u007f<>]+/g, '')

/**
 * A display name as it may stand before an address. Plain words go as they
 * are. Anything else is quoted (or written as encoded words, when it is not
 * short plain ASCII), so punctuation in a name stays part of the name: unquoted,
 * "Smith, John" reads as two recipients, and a name that itself looks like an
 * address, such as "Support <help@company.example>", could be taken for the
 * sender when the file is read back.
 */
function displayName(name: string): string {
  if (!isPlain(name)) return encodeWord(name)
  if (/^[A-Za-z0-9!#$%&'*+\-/=?^_`{|}~ ]*$/.test(name)) return name
  return `"${name.replace(/[\\"]/g, '\\$&')}"`
}

function formatAddress(r: RecipientInfo): string {
  const name = (r.name || '').trim()
  const email = headerSafe(r.email || '').trim()
  if (!email) return displayName(name)
  return name ? `${displayName(name)} <${email}>` : `<${email}>`
}

/** A list of people for To or Cc, leaving out any with neither name nor address. */
const formatAddresses = (list: RecipientInfo[]): string => list.map(formatAddress).filter(Boolean).join(', ')

function boundary(tag: string): string {
  const rand = () => Math.random().toString(36).slice(2)
  return `=_pstv_${tag}_${rand()}${rand()}`
}

function textPart(text: string): string {
  return (
    `Content-Type: text/plain; charset="utf-8"\r\n` +
    `Content-Transfer-Encoding: base64\r\n\r\n${fold(base64Text(text))}`
  )
}

function htmlPart(html: string): string {
  return (
    `Content-Type: text/html; charset="utf-8"\r\n` +
    `Content-Transfer-Encoding: base64\r\n\r\n${fold(base64Text(html))}`
  )
}

/** The message body as text, html, or a multipart/alternative of both. */
function alternativePart(content: MessageContent): string {
  const { html, text } = content
  if (html && text) {
    const b = boundary('alt')
    return (
      `Content-Type: multipart/alternative; boundary="${b}"\r\n\r\n` +
      `--${b}\r\n${textPart(text)}\r\n` +
      `--${b}\r\n${htmlPart(html)}\r\n` +
      `--${b}--\r\n`
    )
  }
  if (html) return `${htmlPart(html)}\r\n`
  return `${textPart(text || '')}\r\n`
}

/** Body plus any inline (cid) images, as multipart/related when needed. */
function bodyPart(content: MessageContent): string {
  const alt = alternativePart(content)
  if (!content.inlineImages.length) return alt
  const b = boundary('rel')
  let s = `Content-Type: multipart/related; boundary="${b}"\r\n\r\n` + `--${b}\r\n${alt}`
  for (const img of content.inlineImages) {
    s +=
      `--${b}\r\n` +
      // Only ever a picture: the body refers to it as one, and a part
      // claiming to be text here would be taken for a body of its own.
      `Content-Type: ${mimeType(img.mime).replace(/^(?!image\/).*$/, 'application/octet-stream')}\r\n` +
      `Content-Transfer-Encoding: base64\r\n` +
      `Content-ID: <${headerSafe(img.cid)}>\r\n` +
      `Content-Disposition: inline\r\n\r\n${fold(base64(img.data))}\r\n`
  }
  return s + `--${b}--\r\n`
}

// Raw bytes per piece of an attachment's base64: a whole number of 57-byte
// groups, each of which encodes to exactly one 76-character line, so pieces
// can be folded on their own and still join into the same text. About 1.9 MB.
const ATTACHMENT_PIECE = 57 * 32768

/**
 * One attachment as a MIME part, in pieces: its headers, then its base64 a
 * piece at a time. A large file is never turned into one huge string, which
 * would cost several times its size in memory while being built.
 */
function* attachmentPart(a: EmlAttachment): Generator<string, void, undefined> {
  const name = quotedParam(a.name || 'attachment')
  yield (
    `Content-Type: ${mimeType(a.mime)}; name="${name}"\r\n` +
    `Content-Transfer-Encoding: base64\r\n` +
    `Content-Disposition: attachment; filename="${name}"\r\n\r\n`
  )
  const bytes = new Uint8Array(a.data)
  for (let i = 0; i < bytes.length; i += ATTACHMENT_PIECE) {
    yield fold(base64(bytes.subarray(i, i + ATTACHMENT_PIECE)))
  }
  yield '\r\n'
}

// Headers that describe the original MIME body, which we are rebuilding.
const BODY_HEADER = /^(content-type|content-transfer-encoding|mime-version|content-disposition|content-id):/i

/**
 * Top-level headers: reuse the message's real transport headers (Received, DKIM,
 * From, To, Subject, Date, Message-ID, etc.) when present, dropping only the
 * ones that describe the old body; otherwise synthesize them from the fields.
 */
function buildHeaders(content: MessageContent): string {
  const raw = content.headers?.trim()
  if (raw) {
    const out: string[] = []
    let skipping = false
    // A lone carriage return ends a line for some readers, so it does here too.
    for (const line of content.headers.split(/\r\n|\r|\n/)) {
      if (/^[ \t]/.test(line)) {
        if (!skipping && out.length) out.push(line) // folded continuation of a kept header
        continue
      }
      if (line.trim() === '') continue
      // Keep only real "Field: value" headers, dropping body-describing ones and
      // Exchange's "Microsoft Mail Internet Headers" banner (which is not a header).
      if (
        !/^[!-9;-~]+:/.test(line) ||
        BODY_HEADER.test(line) ||
        /Microsoft Mail Internet Headers/i.test(line)
      ) {
        skipping = true
        continue
      }
      skipping = false
      out.push(line)
    }
    return out.join('\r\n') + '\r\n'
  }
  const lines: string[] = []
  const from = formatAddress({ name: content.fromName, email: content.fromEmail })
  if (from) lines.push(`From: ${from}`)
  const to = formatAddresses(content.to)
  const cc = formatAddresses(content.cc)
  if (to) lines.push(`To: ${to}`)
  if (cc) lines.push(`Cc: ${cc}`)
  lines.push(`Subject: ${encodeWord(content.subject)}`)
  if (content.date != null) {
    lines.push(`Date: ${new Date(content.date).toUTCString().replace(/GMT$/, '+0000')}`)
  }
  return lines.join('\r\n') + '\r\n'
}

/**
 * A message as RFC822 .eml text (headers, MIME body and attachments), in
 * pieces of a few megabytes at most beyond the headers and body. Each piece is
 * written as it comes, so a message with large attachments never has to exist
 * as one string (which costs memory several times its size, and past about
 * 500 MB is more than a string can hold).
 */
export function* emlParts(
  content: MessageContent,
  attachments: EmlAttachment[],
): Generator<string, void, undefined> {
  const headers = buildHeaders(content) + 'MIME-Version: 1.0\r\n'
  const body = bodyPart(content)
  if (!attachments.length) {
    yield headers + body
    return
  }
  const b = boundary('mix')
  yield headers + `Content-Type: multipart/mixed; boundary="${b}"\r\n\r\n` + `--${b}\r\n${body}`
  for (const a of attachments) {
    yield `--${b}\r\n`
    yield* attachmentPart(a)
  }
  yield `--${b}--\r\n`
}

/** A filesystem-safe .eml filename derived from a message's subject. */
export function emlFilename(subject: string): string {
  const base =
    (subject || 'message')
      .replace(/[^\w.-]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 80) || 'message'
  return `${base}.eml`
}

/** Trigger a browser download of a blob (a local save, like the PDF export). */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 2000)
}
