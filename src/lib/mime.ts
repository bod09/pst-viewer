// Minimal MIME parser to recover the readable html/text body from a raw RFC822
// message, used for the S/MIME signed content extracted from a smime.p7m.

export interface MimeBody {
  html: string | null
  text: string | null
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
  const result: MimeBody = { html: null, text: null }
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
    const parts = latin1(body).split('--' + boundary)
    for (let i = 1; i < parts.length; i++) {
      if (parts[i].startsWith('--')) break
      const sub = extractMimeBody(toBytes(parts[i].replace(/^\r?\n/, '')), depth + 1)
      if (!result.html && sub.html) result.html = sub.html
      if (!result.text && sub.text) result.text = sub.text
    }
  } else if (ct.startsWith('text/html')) {
    result.html = decodeText(headers, body)
  } else if (ct.startsWith('text/plain')) {
    result.text = decodeText(headers, body)
  }
  return result
}
