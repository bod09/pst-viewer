import { describe, expect, test } from 'vitest'
import {
  ansiCodepageFromHints,
  ansiStringDecoder,
  isAnsiPst,
  isSystemAnsiCodepage,
} from '../../src/worker/ansiCodepage'

/** A .pst header's first bytes: the magic, then the format version at offset 10. */
function header(wVer: number, magic = '!BDN'): File {
  const bytes = new Uint8Array(512)
  bytes.set(new TextEncoder().encode(magic), 0)
  bytes[10] = wVer & 0xff
  bytes[11] = wVer >> 8
  return new File([bytes], 'x.pst')
}

describe('telling an ANSI .pst from a Unicode one', () => {
  test.each([
    [14, true],
    [15, true],
    [23, false],
    [36, false],
  ])('format version %i', async (wVer, ansi) => {
    expect(await isAnsiPst(header(wVer))).toBe(ansi)
  })

  test('a file that is not a .pst at all is not an ANSI one', async () => {
    expect(await isAnsiPst(header(14, 'PK\u0003\u0004'))).toBe(false)
    expect(await isAnsiPst(new File([new Uint8Array(4)], 'short.pst'))).toBe(false)
  })
})

describe('the code page a message names', () => {
  test('its own code page wins over its language and its transport', () => {
    expect(ansiCodepageFromHints({ messageCodepage: 1251, localeId: 1041, internetCodepage: 50220 })).toBe(1251)
  })

  test('a language implies its usual code page', () => {
    expect(ansiCodepageFromHints({ localeId: 1041 })).toBe(932)
    expect(ansiCodepageFromHints({ localeId: 1049 })).toBe(1251)
  })

  test('a transport-only encoding implies the code page it is stored in', () => {
    expect(ansiCodepageFromHints({ internetCodepage: 50220 })).toBe(932)
    expect(ansiCodepageFromHints({ internetCodepage: 1250 })).toBe(1250)
  })

  test('a message that says nothing gets no guess', () => {
    expect(ansiCodepageFromHints({})).toBeUndefined()
    expect(ansiCodepageFromHints({ messageCodepage: 'x', localeId: null })).toBeUndefined()
  })

  test('only a code page Windows can run in counts as evidence', () => {
    expect([874, 932, 936, 949, 950, 1250, 1252, 1258].every(isSystemAnsiCodepage)).toBe(true)
    // UTF-8, ISO-8859-1 and iso-2022-jp are how mail travels, not how it is stored.
    expect([65001, 28591, 50220, 1200, 0].some(isSystemAnsiCodepage)).toBe(false)
  })
})

describe('the decoder the parser is given', () => {
  const kana = new Uint8Array([0x83, 0x52, 0x83, 0x80]) // two katakana in Shift-JIS
  const accented = new Uint8Array([0x63, 0x61, 0x66, 0xe9]) // "café" in windows-1252

  test('starts on windows-1252, as the parser always did', () => {
    const d = ansiStringDecoder()
    expect(d.codepage).toBe(1252)
    expect(d.convert(accented)).toBe('café')
  })

  test('switches to the code page it is given, and says so', () => {
    const d = ansiStringDecoder()
    expect(d.use(932)).toBe(true)
    expect(d.codepage).toBe(932)
    expect(d.convert(kana)).toBe('コム')
  })

  test('refuses a code page it cannot decode and stays where it was', () => {
    const d = ansiStringDecoder()
    expect(d.use(424242)).toBe(false)
    expect(d.codepage).toBe(1252)
    expect(d.convert(accented)).toBe('café')
  })

  test('knows whether a code page would have read every string seen', () => {
    const d = ansiStringDecoder()
    d.convert(kana)
    d.convert(new TextEncoder().encode('plain ascii is no evidence'))
    expect(d.fits(932)).toBe(true)
    // 0x81 is a lead byte in Shift-JIS with nothing after it: not Shift-JIS.
    d.convert(new Uint8Array([0x41, 0x81]))
    expect(d.fits(932)).toBe(false)
    expect(d.fits(424242)).toBe(false)
  })

  test('a code page that does not exist never fits, even before anything has been seen', () => {
    expect(ansiStringDecoder().fits(424242)).toBe(false)
    expect(ansiStringDecoder().fits(932)).toBe(true)
  })

  test('a long string is still evidence, wherever its remembered part happens to be cut', () => {
    // Only the start of each string is kept. For two-byte text the cut falls
    // inside a character about half the time, which must not count against
    // the code page: a message body is exactly this kind of string.
    for (const lead of [0, 1, 2, 3]) {
      const d = ansiStringDecoder()
      const body = new Uint8Array(lead + 2 * 400)
      body.fill(0x41, 0, lead)
      for (let i = lead; i < body.length; i += 2) body.set(kana.subarray(0, 2), i)
      d.convert(body)
      expect(d.fits(932), `${lead} ASCII characters in front`).toBe(true)
      // And text that is wrong well before the cut is still caught.
      const wrong = body.slice()
      wrong[lead + 10] = 0x81
      wrong[lead + 11] = 0x20
      d.convert(wrong)
      expect(d.fits(932), `${lead} in front, with a bad pair`).toBe(false)
    }
  })
})
