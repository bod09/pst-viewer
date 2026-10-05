import type { IPSTFile, IPSTFolder, IPSTObject } from '@hiraokahypertools/pst-extractor'
import { encodingLabel } from '../lib/iconv-lite-shim'

/**
 * The code page of an ANSI .pst (Outlook 97-2002, header version 0x0e).
 *
 * A Unicode .pst keeps its text as UTF-16, so every string in it reads the
 * same anywhere. An ANSI one keeps 8-bit strings in whatever code page the
 * machine that wrote it was set to, and records that nowhere in the file
 * header: a Japanese file holds Shift-JIS, a Russian one windows-1251, and
 * the parser, told nothing, reads them all as windows-1252 and shows
 * nonsense. (Standalone .msg files have the same problem; msg.ts handles it.)
 *
 * What the file does say is per message: PR_MESSAGE_CODEPAGE names the code
 * page of the message's own 8-bit strings; PR_MESSAGE_LOCALE_ID names the
 * language it was written in, which has a default code page; and
 * PR_INTERNET_CPID names the encoding it came in over the wire, which for
 * CJK mail usually implies the local one. The message store may carry the
 * same properties. So the file is opened with a decoder that can change its
 * mind, the store and a sample of the messages are asked, and the code page
 * most of them name is used for the whole file, before any folder or message
 * the reader will see is read. A file that names none keeps windows-1252,
 * as before.
 *
 * Only ANSI files are looked at; a Unicode file has nothing to decide, and
 * never decodes differently from before.
 */

const PR_MESSAGE_CODEPAGE = 0x3ffd
const PR_INTERNET_CPID = 0x3fde
const PR_MESSAGE_LOCALE_ID = 0x3ff1

/** The code page the parser used for every ANSI file until now. */
export const DEFAULT_ANSI_CODEPAGE = 1252

/** Default ANSI code page for a message language (PidTagMessageLocaleId). */
export const LOCALE_ANSI_CP: Record<number, number> = {
  1041: 932, // Japanese
  1042: 949, // Korean
  2052: 936, // Chinese (simplified)
  1028: 950, // Chinese (traditional)
  1049: 1251, 1058: 1251, 1026: 1251, // Russian / Ukrainian / Bulgarian
  1032: 1253, // Greek
  1037: 1255, // Hebrew
  1025: 1256, // Arabic
  1054: 874, // Thai
  1055: 1254, // Turkish
  1029: 1250, 1038: 1250, 1045: 1250, 1048: 1250, 1051: 1250, 1060: 1250, // Central European
  1061: 1257, 1062: 1257, 1063: 1257, // Baltic
}

/**
 * Transport-only internet encodings mapped to the ANSI code page actually used
 * for stored 8-bit strings (e.g. iso-2022-jp mail stores Shift-JIS text).
 */
export const NET_ANSI_CP: Record<number, number> = {
  50220: 932, 50221: 932, 50222: 932, 51932: 932,
  51949: 949,
  52936: 936,
}

export interface CodepageHints {
  messageCodepage?: unknown
  localeId?: unknown
  internetCodepage?: unknown
}

/**
 * Best guess at the code page of an item's 8-bit strings, from what it says
 * about itself: its own code page first, then the one its language implies,
 * then the one it was sent in.
 */
export function ansiCodepageFromHints(hints: CodepageHints): number | undefined {
  if (typeof hints.messageCodepage === 'number') return hints.messageCodepage
  const viaLocale = typeof hints.localeId === 'number' ? LOCALE_ANSI_CP[hints.localeId] : undefined
  if (viaLocale !== undefined) return viaLocale
  const net = hints.internetCodepage
  if (typeof net === 'number') return NET_ANSI_CP[net] ?? net
  return undefined
}

/**
 * Whether Windows could have been running with this as its ANSI code page.
 * Only such a code page can be the one an ANSI file's strings are in: a
 * message received as UTF-8 or ISO-8859-1 mail was still stored in the
 * writer's own, so those are no evidence of anything.
 */
export function isSystemAnsiCodepage(cp: number): boolean {
  return cp === 874 || cp === 932 || cp === 936 || cp === 949 || cp === 950 || (cp >= 1250 && cp <= 1258)
}

function codepageHintsOf(item: IPSTObject): number | undefined {
  const read = (tag: number) => {
    try {
      const v = item.getProperty(tag)?.value
      return typeof v === 'number' && v > 0 ? v : undefined
    } catch {
      return undefined
    }
  }
  const cp = ansiCodepageFromHints({
    messageCodepage: read(PR_MESSAGE_CODEPAGE),
    localeId: read(PR_MESSAGE_LOCALE_ID),
    internetCodepage: read(PR_INTERNET_CPID),
  })
  return cp !== undefined && isSystemAnsiCodepage(cp) ? cp : undefined
}

/**
 * Is this file an ANSI .pst? The header's wVer is 14 or 15 for the old
 * format, 23 for Unicode and 36 for the 4 KB page variant of .ost.
 */
export async function isAnsiPst(file: Blob): Promise<boolean> {
  try {
    const head = new Uint8Array(await file.slice(0, 12).arrayBuffer())
    if (head.length < 12) return false
    // "!BDN"
    if (head[0] !== 0x21 || head[1] !== 0x42 || head[2] !== 0x44 || head[3] !== 0x4e) return false
    const wVer = head[10] | (head[11] << 8)
    return wVer === 14 || wVer === 15
  } catch {
    return false
  }
}

/** The parser's ANSI string decoder, which can be given a code page after the file is open. */
export interface AnsiStringDecoder {
  /** Handed to the parser as `convertAnsiStringImmediately`. */
  convert: (bytes: Uint8Array) => string
  /** The code page in use. */
  readonly codepage: number
  /** Switch to a code page; false (and no change) if it is not one TextDecoder knows. */
  use(cp: number): boolean
  /**
   * Would this code page have read every non-ASCII string seen so far? A
   * guard for a file whose messages name a code page their strings are not
   * in, where guessing wrong would be worse than leaving the default.
   */
  fits(cp: number): boolean
}

/** Non-ASCII strings remembered for `fits`; a handful is enough to catch a wrong guess. */
const SAMPLE_STRINGS = 32
const SAMPLE_BYTES = 256

export function ansiStringDecoder(): AnsiStringDecoder {
  let codepage = DEFAULT_ANSI_CODEPAGE
  let decoder = new TextDecoder('windows-1252')
  // The start of each string, and whether there was more of it: a string
  // that was cut may end inside a character, which is not the string's fault.
  const samples: { bytes: Uint8Array; cut: boolean }[] = []
  return {
    convert(bytes) {
      if (samples.length < SAMPLE_STRINGS && bytes.some((b) => b >= 0x80)) {
        samples.push({ bytes: bytes.slice(0, SAMPLE_BYTES), cut: bytes.length > SAMPLE_BYTES })
      }
      return decoder.decode(bytes)
    },
    get codepage() {
      return codepage
    },
    use(cp) {
      try {
        decoder = new TextDecoder(encodingLabel(String(cp)))
      } catch {
        return false
      }
      codepage = cp
      return true
    },
    fits(cp) {
      const label = encodingLabel(String(cp))
      try {
        new TextDecoder(label)
      } catch {
        return false // not a code page TextDecoder knows, whatever was seen
      }
      return samples.every(({ bytes, cut }) => {
        try {
          // A decoder to each sample, because one told that more is coming
          // (`stream`, for a sample that was cut) holds on to a half-read
          // character and would carry it into the next.
          new TextDecoder(label, { fatal: true }).decode(bytes, { stream: cut })
          return true
        } catch {
          return false // not text in this code page
        }
      })
    },
  }
}

/** How many messages are asked before the vote is called. */
const SAMPLE_MESSAGES = 64
/** At most this many from one folder, so one big folder does not drown the rest. */
const PER_FOLDER = 8

/**
 * The code page an ANSI file's messages say they are in, or undefined when
 * none of them (nor the store) names one.
 *
 * The messages are read one at a time and let go, as everywhere else in the
 * worker; the sample is small and spread over the folders.
 */
export async function detectAnsiCodepage(pst: IPSTFile): Promise<number | undefined> {
  try {
    const fromStore = codepageHintsOf(await pst.getMessageStore())
    if (fromStore !== undefined) return fromStore
  } catch {
    // The store is optional evidence; the messages are asked next.
  }

  const votes = new Map<number, number>()
  let asked = 0
  const walk = async (folder: IPSTFolder): Promise<void> => {
    if (asked >= SAMPLE_MESSAGES) return
    let count = 0
    try {
      count = await folder.getEmailCount()
    } catch {
      count = 0
    }
    for (let i = 0; i < Math.min(count, PER_FOLDER) && asked < SAMPLE_MESSAGES; i++) {
      asked++
      try {
        const cp = codepageHintsOf(await folder.getEmail(i))
        if (cp !== undefined) votes.set(cp, (votes.get(cp) ?? 0) + 1)
      } catch {
        // An unreadable message is skipped here as it is everywhere else.
      }
    }
    let subs: IPSTFolder[] = []
    try {
      subs = await folder.getSubFolders()
    } catch {
      subs = []
    }
    for (const sub of subs) await walk(sub)
  }
  try {
    await walk(await pst.getRootFolder())
  } catch {
    // Whatever was counted before the walk failed still counts.
  }

  let best: number | undefined
  let most = 0
  for (const [cp, n] of votes) {
    if (n > most) [best, most] = [cp, n]
  }
  return best
}

/**
 * Decide the code page for a freshly opened ANSI file and switch the decoder
 * to it. Returns the code page in use afterwards.
 */
export async function chooseAnsiCodepage(pst: IPSTFile, decoder: AnsiStringDecoder): Promise<number> {
  const cp = await detectAnsiCodepage(pst)
  if (cp !== undefined && cp !== decoder.codepage && decoder.fits(cp)) decoder.use(cp)
  return decoder.codepage
}
