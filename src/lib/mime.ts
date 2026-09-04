// Minimal MIME parser to recover the readable html/text body from a raw RFC822
// message, used for the S/MIME signed content extracted from a smime.p7m.

export interface MimeAttachment {
  name: string
  mime: string
  data: ArrayBuffer
  /** Content-ID, when the part is referenced from the body by cid:. */
  cid: string
}

export interface MimeBody {
  html: string | null
  text: string | null
  /** Files carried alongside the body, e.g. inside a signed S/MIME envelope. */
  attachments: MimeAttachment[]
}

const latin1 = (b: Uint8Array): string => {
  let s = ''
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000))
  return s
}
const toBytes = (s: string): Uint8Array => {
  const b = new Uint8Array(s.length)
  for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i) & 0xff
  return b
}
const b64ToBytes = (b64: string): Uint8Array => {
  try {
    return toBytes(atob(b64.replace(/[^A-Za-z0-9+/=]/g, '')))
  } catch {
    return new Uint8Array(0)
  }
}
const qpToBytes = (s: string): Uint8Array => {
  const clean = s.replace(/=\r?\n/g, '')
  const out: number[] = []
  for (let i = 0; i < clean.length; i++) {
    if (clean[i] === '=' && /^[0-9a-f]{2}$/i.test(clean.substr(i + 1, 2))) {
      out.push(parseInt(clean.substr(i + 1, 2), 16))
      i += 2
    } else {
      out.push(clean.charCodeAt(i) & 0xff)
    }
  }
  return new Uint8Array(out)
}

function parseHeaders(headText: string): Map<string, string> {
  const map = new Map<string, string>()
  const unfolded = headText.replace(/\r?\n[ \t]+/g, ' ')
  for (const line of unfolded.split(/\r?\n/)) {
    const i = line.indexOf(':')
    if (i > 0) map.set(line.slice(0, i).trim().toLowerCase(), line.slice(i + 1).trim())
  }
  return map
}

/** Bytes of a part, honouring its transfer encoding. Null if unusable. */
function decodeBinary(headers: Map<string, string>, body: string): ArrayBuffer | null {
  try {
    const enc = (headers.get('content-transfer-encoding') || '').toLowerCase().trim()
    if (enc === 'base64') {
      const clean = body.replace(/[^A-Za-z0-9+/=]/g, '')
      if (!clean) return null
      const bin = atob(clean)
      const out = new Uint8Array(bin.length)
      for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
      return out.buffer
    }
    // quoted-printable and 7bit/8bit are already the bytes we read.
    if (enc === 'quoted-printable') return qpToBytes(body).buffer as ArrayBuffer
    const text = body
    const out = new Uint8Array(text.length)
    for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i) & 0xff
    return out.buffer
  } catch {
    return null
  }
}

function decodeText(headers: Map<string, string>, bodyBytes: Uint8Array): string {
  const enc = (headers.get('content-transfer-encoding') || '').toLowerCase()
  const ct = headers.get('content-type') || ''
  const charset = (/charset="?([^";]+)"?/i.exec(ct)?.[1] || 'utf-8').trim()
  let bytes = bodyBytes
  if (enc === 'base64') bytes = b64ToBytes(latin1(bodyBytes))
  else if (enc === 'quoted-printable') bytes = qpToBytes(latin1(bodyBytes))
  try {
    return new TextDecoder(charset).decode(bytes).trim()
  } catch {
    return new TextDecoder('utf-8').decode(bytes).trim()
  }
}

/** Recover the readable html/text body from a raw MIME message. */
export function extractMimeBody(input: Uint8Array, depth = 0): MimeBody {
  const result: MimeBody = { html: null, text: null, attachments: [] }
  if (depth > 8) return result
  const s = latin1(input)
  const m = /\r\n\r\n|\n\n/.exec(s)
  if (!m) return result
  const headers = parseHeaders(s.slice(0, m.index))
  const ctRaw = headers.get('content-type') || 'text/plain'
  const ct = ctRaw.toLowerCase()
  const body = input.subarray(m.index + m[0].length)
  if (ct.startsWith('multipart/')) {
    const boundary = /boundary="?([^";]+)"?/i.exec(ctRaw)?.[1]
    if (!boundary) return result
    // A boundary only counts at the start of a line. Splitting on the bare
    // string would also cut wherever those characters happen to appear inside
    // encoded content, which breaks the part it appears in.
    const escaped = boundary.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const delimiter = new RegExp(`(?:^|\r?\n)--${escaped}(--)?[ \t]*(?=\r?\n|$)`, 'g')
    const raw = latin1(body)
    const pieces: string[] = []
    let last = -1
    let hit: RegExpExecArray | null
    while ((hit = delimiter.exec(raw))) {
      if (last >= 0) pieces.push(raw.slice(last, hit.index))
      if (hit[1]) break // the closing --boundary--
      last = hit.index + hit[0].length
    }
    // multipart/alternative lists the same content simplest first, so the last
    // usable version wins there; elsewhere the first body part is the body.
    const alternative = ct.startsWith('multipart/alternative')
    for (const piece of pieces) {
      const split = /\r\n\r\n|\n\n/.exec(piece)
      const partHeaders = parseHeaders(split ? piece.slice(0, split.index) : piece)
      const dispositionRaw = partHeaders.get('content-disposition') || ''
      const disposition = dispositionRaw.toLowerCase()
      const partType = partHeaders.get('content-type') || ''
      const cid = (partHeaders.get('content-id') || '').replace(/^<|>$/g, '').trim()
      // An attached file is not the message body, even when it is text. It is
      // still part of the message though, so it is carried out rather than
      // dropped: inside a signed envelope this is the only route to it.
      const isAttachment =
        disposition.trim().startsWith('attachment') ||
        (!!cid && !partType.toLowerCase().startsWith('multipart/'))
      if (isAttachment && split) {
        const body = piece.slice(split.index + split[0].length)
        const data = decodeBinary(partHeaders, body)
        if (data) {
          result.attachments.push({
            // Read the name from the untouched header: lower-casing it for
            // the checks above would also rename the file.
            name:
              /filename="?([^";]+)"?/i.exec(dispositionRaw)?.[1]?.trim() ||
              /name="?([^";]+)"?/i.exec(partType)?.[1]?.trim() ||
              'attachment',
            mime: partType.split(';')[0].trim() || 'application/octet-stream',
            data,
            cid,
          })
        }
        continue
      }
      const sub = extractMimeBody(toBytes(piece.replace(/^\r?\n/, '')), depth + 1)
      if (sub.html && (alternative || !result.html)) result.html = sub.html
      if (sub.text && (alternative || !result.text)) result.text = sub.text
      if (sub.attachments.length) result.attachments.push(...sub.attachments)
    }
  } else if (ct.startsWith('text/html')) {
    result.html = decodeText(headers, body)
  } else if (ct.startsWith('text/plain')) {
    result.text = decodeText(headers, body)
  }
  return result
}
