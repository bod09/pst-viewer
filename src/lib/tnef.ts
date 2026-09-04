// Minimal parser for TNEF (Transport Neutral Encapsulation Format), the
// proprietary "winmail.dat" Outlook sometimes wraps a message in. It recovers
// the real attachments and a plain-text body; the RTF/MAPI-stream body is not
// decoded here (rare in practice, and the attachments are the high-value part).

export interface TnefAttachment {
  name: string
  mime: string
  data: ArrayBuffer
}

export interface TnefResult {
  bodyText: string | null
  attachments: TnefAttachment[]
}

const SIGNATURE = 0x223e9f78

// Low 16 bits of the 4-byte attribute id.
const ATT_BODY = 0x800c
const ATT_ATTACH_RENDDATA = 0x9002
const ATT_ATTACH_TITLE = 0x8010
const ATT_ATTACH_DATA = 0x800f
// Per-attachment MAPI properties, which carry the real (long) filename.
const ATT_ATTACHMENT = 0x9005
// The code page the 8-bit strings in this stream are written in.
const ATT_OEM_CODEPAGE = 0x9007

// MAPI property tags found inside ATT_ATTACHMENT.
const PR_ATTACH_LONG_FILENAME = 0x3707
const PR_ATTACH_MIME_TAG = 0x370e
const PT_UNICODE = 0x001f

const labelForCodepage = (cp: number): string => {
  switch (cp) {
    case 932: return 'shift_jis'
    case 936: return 'gbk'
    case 949: return 'euc-kr'
    case 950: return 'big5'
    case 874: return 'windows-874'
    case 1250: return 'windows-1250'
    case 1251: return 'windows-1251'
    case 1253: return 'windows-1253'
    case 1254: return 'windows-1254'
    case 1255: return 'windows-1255'
    case 1256: return 'windows-1256'
    case 1257: return 'windows-1257'
    case 1258: return 'windows-1258'
    case 65001: return 'utf-8'
    default: return 'windows-1252'
  }
}

const decodeWith = (data: ArrayBuffer, label: string): string => {
  try {
    return new TextDecoder(label, { fatal: false })
      .decode(new Uint8Array(data))
      .replace(/\0+$/, '')
      .trim()
  } catch {
    return new TextDecoder('windows-1252')
      .decode(new Uint8Array(data))
      .replace(/\0+$/, '')
      .trim()
  }
}

/**
 * Pull the long filename and mime type out of an attachment's MAPI property
 * block. The plain title attribute only carries the old 8.3 short name, so a
 * file called "Quarterly Report Final.pdf" would otherwise be recovered as
 * something like "QUARTE~1.PDF".
 */
function readAttachmentProps(
  data: ArrayBuffer,
  codepage: string,
): { name?: string; mime?: string } {
  const out: { name?: string; mime?: string } = {}
  try {
    const dv = new DataView(data)
    if (data.byteLength < 4) return out
    const count = dv.getUint32(0, true)
    if (count > 1000) return out
    let off = 4
    for (let i = 0; i < count && off + 8 <= data.byteLength; i++) {
      const type = dv.getUint16(off, true)
      const tag = dv.getUint16(off + 2, true)
      off += 4
      if (tag >= 0x8000) off += 16 // named property GUID + kind
      // Only the two string properties are of interest; anything else means
      // the layout is past what this reader understands, so stop.
      if (type !== PT_UNICODE && type !== 0x001e) return out
      const values = dv.getUint32(off, true)
      off += 4
      for (let v = 0; v < values && off + 4 <= data.byteLength; v++) {
        const len = dv.getUint32(off, true)
        off += 4
        if (len < 0 || off + len > data.byteLength) return out
        const raw = data.slice(off, off + len)
        off += len
        off += (4 - (len % 4)) % 4 // values are padded to 4 bytes
        const text =
          type === PT_UNICODE
            ? decodeWith(raw, 'utf-16le')
            : decodeWith(raw, codepage)
        if (tag === PR_ATTACH_LONG_FILENAME && text) out.name = text
        else if (tag === PR_ATTACH_MIME_TAG && text) out.mime = text
      }
    }
  } catch {
    /* a shape we do not understand: keep whatever the short name gave us */
  }
  return out
}

/** Parse a winmail.dat byte stream, or return null if it is not valid TNEF. */
export function parseTnef(buf: ArrayBuffer): TnefResult | null {
  if (buf.byteLength < 6) return null
  const dv = new DataView(buf)
  if (dv.getUint32(0, true) !== SIGNATURE) return null

  const result: TnefResult = { bodyText: null, attachments: [] }
  // Strings are in this code page unless the stream says otherwise.
  let codepage = 'windows-1252'
  const decodeString = (data: ArrayBuffer): string => decodeWith(data, codepage)
  let cur: TnefAttachment | null = null
  const flush = () => {
    if (cur && cur.data.byteLength > 0) result.attachments.push(cur)
    cur = null
  }
  const ensure = (): TnefAttachment => (cur ??= { name: '', mime: '', data: new ArrayBuffer(0) })

  let off = 6 // signature (4) + key (2)
  while (off + 9 <= buf.byteLength) {
    const level = dv.getUint8(off)
    const attr = dv.getUint32(off + 1, true)
    const len = dv.getUint32(off + 5, true)
    off += 9
    if (len < 0 || off + len + 2 > buf.byteLength) break
    const data = buf.slice(off, off + len)
    off += len + 2 // data + 2-byte checksum
    const id = attr & 0xffff

    if (level === 1) {
      if (id === ATT_OEM_CODEPAGE && data.byteLength >= 4) {
        codepage = labelForCodepage(new DataView(data).getUint32(0, true))
      } else if (id === ATT_BODY && !result.bodyText) {
        result.bodyText = decodeString(data) || null
      }
    } else if (level === 2) {
      if (id === ATT_ATTACH_RENDDATA) {
        flush()
        cur = { name: '', mime: '', data: new ArrayBuffer(0) }
      } else if (id === ATT_ATTACH_TITLE) {
        ensure().name = decodeString(data)
      } else if (id === ATT_ATTACH_DATA) {
        ensure().data = data
      } else if (id === ATT_ATTACHMENT) {
        const props = readAttachmentProps(data, codepage)
        const a = ensure()
        if (props.name) a.name = props.name // long name beats the 8.3 one
        if (props.mime) a.mime = props.mime
      }
    }
  }
  flush()
  return result
}
