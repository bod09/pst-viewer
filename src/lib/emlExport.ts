import type { MessageContent, RecipientInfo } from '../types'

/** A non-inline attachment's bytes, fetched on demand for the export. */
export interface EmlAttachment {
  name: string
  mime: string
  data: ArrayBuffer
}

function base64(bytes: ArrayBuffer): string {
  const arr = new Uint8Array(bytes)
  const chunks: string[] = []
  const size = 0x8000
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(String.fromCharCode(...arr.subarray(i, i + size)))
  }
  return btoa(chunks.join(''))
}

function base64Text(s: string): string {
  return base64(new TextEncoder().encode(s).buffer as ArrayBuffer)
}

/** Wrap base64 to 76-char lines, as MIME requires. */
function fold(b64: string): string {
  return b64.replace(/.{1,76}/g, '$&\r\n')
}

/** RFC 2047 encode a header value when it contains non-ASCII characters. */
function encodeWord(s: string): string {
  return /^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${base64Text(s)}?=`
}

/**
 * A value safe to place inside a quoted MIME parameter. A filename carrying a
 * quote, a semicolon or a line break would otherwise close the parameter and
 * let the rest be read as headers, which matters when the exported file is
 * evidence someone else will open.
 */
function quotedParam(s: string): string {
  const plain = s.replace(/[\r\n]+/g, ' ')
  if (!/^[\x20-\x7e]*$/.test(plain)) return `=?UTF-8?B?${base64Text(plain)}?=`
  return plain.replace(/["\\]/g, '_')
}

/** Strip anything that could break out of a header line. */
const headerSafe = (s: string): string => s.replace(/[\r\n<>]+/g, '')

function formatAddress(r: RecipientInfo): string {
  if (!r.email) return encodeWord(r.name || '')
  return r.name ? `${encodeWord(r.name)} <${r.email}>` : `<${r.email}>`
}

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
      `Content-Type: ${img.mime || 'application/octet-stream'}\r\n` +
      `Content-Transfer-Encoding: base64\r\n` +
      `Content-ID: <${headerSafe(img.cid)}>\r\n` +
      `Content-Disposition: inline\r\n\r\n${fold(base64(img.data))}\r\n`
  }
  return s + `--${b}--\r\n`
}

function attachmentPart(a: EmlAttachment): string {
  const name = quotedParam(a.name || 'attachment')
  return (
    `Content-Type: ${a.mime || 'application/octet-stream'}; name="${name}"\r\n` +
    `Content-Transfer-Encoding: base64\r\n` +
    `Content-Disposition: attachment; filename="${name}"\r\n\r\n${fold(base64(a.data))}\r\n`
  )
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
    for (const line of content.headers.split(/\r?\n/)) {
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
  const from = content.fromEmail
    ? `${content.fromName ? encodeWord(content.fromName) + ' ' : ''}<${content.fromEmail}>`
    : encodeWord(content.fromName || '')
  if (from) lines.push(`From: ${from}`)
  if (content.to.length) lines.push(`To: ${content.to.map(formatAddress).join(', ')}`)
  if (content.cc.length) lines.push(`Cc: ${content.cc.map(formatAddress).join(', ')}`)
  lines.push(`Subject: ${encodeWord(content.subject)}`)
  if (content.date != null) {
    lines.push(`Date: ${new Date(content.date).toUTCString().replace(/GMT$/, '+0000')}`)
  }
  return lines.join('\r\n') + '\r\n'
}

/** Reconstruct a message as RFC822 .eml text (headers + MIME body + attachments). */
export function buildEml(content: MessageContent, attachments: EmlAttachment[]): string {
  const headers = buildHeaders(content) + 'MIME-Version: 1.0\r\n'
  const body = bodyPart(content)
  if (!attachments.length) return headers + body
  const b = boundary('mix')
  let s = headers + `Content-Type: multipart/mixed; boundary="${b}"\r\n\r\n` + `--${b}\r\n${body}`
  for (const a of attachments) s += `--${b}\r\n${attachmentPart(a)}`
  return s + `--${b}--\r\n`
}

/** A filesystem-safe .eml filename derived from the subject. */
export function emlFilename(content: MessageContent): string {
  const base =
    (content.subject || 'message')
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
