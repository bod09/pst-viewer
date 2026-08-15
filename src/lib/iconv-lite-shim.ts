/**
 * Browser stand-in for `iconv-lite` (aliased in vite.config.ts).
 *
 * @kenjiuno/msgreader's DataStream imports iconv-lite at module load, but the
 * real package needs Node's Buffer. It is only ever called for PT_STRING8
 * (8-bit "ANSI") message properties when a `parserConfig.ansiEncoding` is set;
 * TextDecoder covers those code pages natively in every browser we target.
 */

function normalizeLabel(encoding: string): string {
  const e = (encoding || '').toLowerCase().replace(/[^a-z0-9]/g, '')
  // Bare code-page numbers and cpNNNN/winNNNN spellings → WHATWG labels.
  const m = /^(?:cp|win|windows)?(\d{3,5})$/.exec(e)
  if (m) {
    const cp = Number(m[1])
    if (cp >= 1250 && cp <= 1258) return `windows-${cp}`
    if (cp === 932) return 'shift_jis'
    if (cp === 936) return 'gbk'
    if (cp === 949) return 'euc-kr'
    if (cp === 950) return 'big5'
    if (cp === 866) return 'ibm866'
    if (cp === 874) return 'windows-874'
    if (cp >= 28591 && cp <= 28606) return `iso-8859-${cp - 28590}`
    if (cp >= 50220 && cp <= 50222) return 'iso-2022-jp'
    if (cp === 51932) return 'euc-jp'
    if (cp === 51949) return 'euc-kr'
    if (cp === 52936 || cp === 54936) return 'gb18030'
    if (cp === 20866) return 'koi8-r'
    if (cp === 21866) return 'koi8-u'
    if (cp === 10000) return 'macintosh'
    if (cp === 65001 || cp === 20127) return 'utf-8'
    if (cp === 1200) return 'utf-16le'
    if (cp === 1201) return 'utf-16be'
  }
  return encoding || 'utf-8'
}

export function decode(bytes: Uint8Array, encoding: string): string {
  try {
    return new TextDecoder(normalizeLabel(encoding), { fatal: false }).decode(bytes)
  } catch {
    return new TextDecoder('utf-8', { fatal: false }).decode(bytes)
  }
}

export function encode(str: string, _encoding?: string): Uint8Array {
  return new TextEncoder().encode(str)
}

export default { decode, encode }
