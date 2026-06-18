/**
 * File-type detection by magic numbers + filename, ported and extended from
 * the previous project's `detect_ext`. Used to pick the right inline preview
 * and to give downloads a correct extension/MIME.
 */

export type PreviewCategory =
  | 'image'
  | 'pdf'
  | 'text'
  | 'audio'
  | 'video'
  | 'email'
  | 'office'
  | 'archive'
  | 'other'

export interface DetectedType {
  ext: string // without leading dot
  mime: string
  category: PreviewCategory
}

const EXT_MIME: Record<string, string> = {
  // images
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
  // docs
  pdf: 'application/pdf',
  rtf: 'application/rtf',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  odt: 'application/vnd.oasis.opendocument.text',
  ods: 'application/vnd.oasis.opendocument.spreadsheet',
  // text/code
  txt: 'text/plain',
  csv: 'text/csv',
  log: 'text/plain',
  md: 'text/markdown',
  json: 'application/json',
  xml: 'text/xml',
  html: 'text/html',
  htm: 'text/html',
  ics: 'text/calendar',
  eml: 'message/rfc822',
  // audio
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  flac: 'audio/flac',
  m4a: 'audio/mp4',
  // video
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  mov: 'video/quicktime',
  avi: 'video/x-msvideo',
  mkv: 'video/x-matroska',
  webm: 'video/webm',
  // archives
  zip: 'application/zip',
  '7z': 'application/x-7z-compressed',
  rar: 'application/vnd.rar',
  gz: 'application/gzip',
  bz2: 'application/x-bzip2',
}

const IMAGE = new Set(['png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp', 'svg', 'tif', 'tiff', 'ico'])
const TEXT = new Set(['txt', 'csv', 'log', 'md', 'json', 'xml', 'html', 'htm', 'ics', 'rtf'])
const AUDIO = new Set(['mp3', 'wav', 'ogg', 'flac', 'm4a'])
const VIDEO = new Set(['mp4', 'm4v', 'mov', 'avi', 'mkv', 'webm'])
const OFFICE = new Set(['doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'odt', 'ods'])
const ARCHIVE = new Set(['zip', '7z', 'rar', 'gz', 'bz2'])

export function categoryForExt(ext: string): PreviewCategory {
  if (ext === 'pdf') return 'pdf'
  if (ext === 'eml') return 'email'
  if (IMAGE.has(ext)) return 'image'
  if (TEXT.has(ext)) return 'text'
  if (AUDIO.has(ext)) return 'audio'
  if (VIDEO.has(ext)) return 'video'
  if (OFFICE.has(ext)) return 'office'
  if (ARCHIVE.has(ext)) return 'archive'
  return 'other'
}

function extFromName(name: string): string {
  const m = /\.([A-Za-z0-9]+)$/.exec(name)
  return m ? m[1].toLowerCase() : ''
}

function hexStarts(bytes: Uint8Array, hex: string): boolean {
  const need = hex.length / 2
  if (bytes.length < need) return false
  for (let i = 0; i < need; i++) {
    const b = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
    if (bytes[i] !== b) return false
  }
  return true
}

const SIGNATURES: Array<[string, string]> = [
  ['25504446', 'pdf'],
  ['89504E47', 'png'],
  ['47494638', 'gif'],
  ['FFD8FF', 'jpg'],
  ['424D', 'bmp'],
  ['49492A00', 'tif'],
  ['4D4D002A', 'tif'],
  ['377ABCAF271C', '7z'],
  ['526172211A07', 'rar'],
  ['1F8B08', 'gz'],
  ['425A68', 'bz2'],
  ['494433', 'mp3'],
  ['4F676753', 'ogg'],
  ['664C6143', 'flac'],
  ['7B5C72746631', 'rtf'],
  ['D0CF11E0A1B11AE1', 'doc'], // legacy OLE (doc/xls/ppt/msg)
  ['1A45DFA3', 'mkv'],
]

/** Sniff a binary signature from the first bytes. Returns ext or ''. */
function sniff(bytes: Uint8Array): string {
  for (const [hex, ext] of SIGNATURES) {
    if (hexStarts(bytes, hex)) return ext
  }
  // RIFF containers (WEBP / WAV / AVI)
  if (hexStarts(bytes, '52494646') && bytes.length >= 12) {
    const tag = String.fromCharCode(bytes[8], bytes[9], bytes[10], bytes[11])
    if (tag === 'WEBP') return 'webp'
    if (tag === 'WAVE') return 'wav'
    if (tag === 'AVI ') return 'avi'
  }
  // ISO-BMFF (mp4/mov/m4a) — 'ftyp' at offset 4
  if (bytes.length >= 12 && String.fromCharCode(bytes[4], bytes[5], bytes[6], bytes[7]) === 'ftyp') {
    const brand = String.fromCharCode(bytes[8], bytes[9], bytes[10], bytes[11])
    if (brand.startsWith('qt')) return 'mov'
    if (brand.startsWith('M4A')) return 'm4a'
    return 'mp4'
  }
  // OOXML / OpenDocument / generic zip
  if (hexStarts(bytes, '504B0304') || hexStarts(bytes, '504B0506') || hexStarts(bytes, '504B0708')) {
    return 'zip'
  }
  return ''
}

/**
 * Resolve an attachment's type from (in priority order) its bytes, then its
 * declared MIME, then its filename. `bytes` may be null when only metadata is
 * known (e.g. building the chip list before the data is fetched).
 */
export function detectType(
  bytes: Uint8Array | null,
  name: string,
  declaredMime: string,
): DetectedType {
  const nameExt = extFromName(name)

  // 1) Trust magic numbers when available — but keep the OOXML/Office ext from
  //    the filename, since a zip signature alone can't tell docx from xlsx.
  if (bytes && bytes.length >= 4) {
    const sig = sniff(bytes)
    if (sig === 'zip') {
      const ext = OFFICE.has(nameExt) ? nameExt : 'zip'
      return { ext, mime: EXT_MIME[ext] ?? 'application/zip', category: categoryForExt(ext) }
    }
    if (sig === 'doc' && OFFICE.has(nameExt)) {
      return { ext: nameExt, mime: EXT_MIME[nameExt]!, category: 'office' }
    }
    if (sig) {
      return { ext: sig, mime: EXT_MIME[sig] ?? declaredMime ?? '', category: categoryForExt(sig) }
    }
    // Looks like printable text?
    if (looksTextual(bytes)) {
      const ext = TEXT.has(nameExt) ? nameExt : 'txt'
      return { ext, mime: EXT_MIME[ext] ?? 'text/plain', category: 'text' }
    }
  }

  // 2) Declared MIME.
  if (declaredMime) {
    const fromMime = extFromMime(declaredMime)
    if (fromMime) {
      return { ext: fromMime, mime: declaredMime, category: categoryForExt(fromMime) }
    }
  }

  // 3) Filename extension.
  if (nameExt) {
    return {
      ext: nameExt,
      mime: EXT_MIME[nameExt] ?? declaredMime ?? 'application/octet-stream',
      category: categoryForExt(nameExt),
    }
  }

  return { ext: '', mime: declaredMime || 'application/octet-stream', category: 'other' }
}

/** Lightweight category guess from name + MIME only (no bytes). */
export function categoryFromNameMime(name: string, mime: string): PreviewCategory {
  const ext = extFromName(name)
  if (ext) return categoryForExt(ext)
  const fromMime = extFromMime(mime)
  if (fromMime) return categoryForExt(fromMime)
  if (mime.startsWith('image/')) return 'image'
  if (mime.startsWith('audio/')) return 'audio'
  if (mime.startsWith('video/')) return 'video'
  if (mime.startsWith('text/')) return 'text'
  if (mime === 'application/pdf') return 'pdf'
  if (mime === 'message/rfc822') return 'email'
  return 'other'
}

function extFromMime(mime: string): string {
  const base = mime.split(';')[0].trim().toLowerCase()
  for (const [ext, m] of Object.entries(EXT_MIME)) {
    if (m === base) return ext
  }
  if (base.startsWith('image/')) return base.slice(6)
  if (base === 'text/plain') return 'txt'
  return ''
}

function looksTextual(bytes: Uint8Array): boolean {
  const n = Math.min(bytes.length, 512)
  if (n === 0) return false
  let suspicious = 0
  for (let i = 0; i < n; i++) {
    const b = bytes[i]
    if (b === 0) return false // NUL → binary
    if (b < 9 || (b > 13 && b < 32)) suspicious++
  }
  return suspicious / n < 0.1
}
