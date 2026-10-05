import { describe, expect, test } from 'vitest'
import { deEncapsulateRtf } from '../../src/worker/pst.worker'

describe('deEncapsulateRtf', () => {
  test('text that is not RTF gives nothing', () => {
    expect(deEncapsulateRtf('')).toEqual({ html: '', text: '' })
    expect(deEncapsulateRtf('just some words')).toEqual({ html: '', text: '' })
  })

  test('the original HTML is recovered from an HTML message stored as RTF', () => {
    const rtf =
      '{\\rtf1\\ansi\\ansicpg1252\\fromhtml1 \\deff0{\\fonttbl{\\f0\\fswiss Arial;}}' +
      '{\\*\\htmltag64 <html>}{\\*\\htmltag64 <body>}' +
      '{\\*\\htmltag64 <p>}\\htmlrtf {\\htmlrtf0 Hello {\\*\\htmltag84 <b>}\\htmlrtf {\\b \\htmlrtf0 world' +
      '{\\*\\htmltag92 </b>}\\htmlrtf }\\htmlrtf0 !\\htmlrtf\\par}\\htmlrtf0' +
      '{\\*\\htmltag72 </p>}{\\*\\htmltag64 </body>}{\\*\\htmltag64 </html>}}'
    expect(deEncapsulateRtf(rtf)).toEqual({
      html: '<html><body><p>Hello <b>world</b>!</p></body></html>',
      text: '',
    })
  })

  test('formatting that only an RTF reader needs is left out of the HTML', () => {
    const rtf =
      '{\\rtf1\\fromhtml1{\\colortbl;\\red255\\green0\\blue0;}{\\stylesheet{\\s0 Normal;}}' +
      '{\\*\\generator Riched20 10.0;}{\\*\\htmltag <p>}kept{\\*\\htmltag </p>}' +
      '\\htmlrtf this is only for RTF readers\\htmlrtf0}'
    expect(deEncapsulateRtf(rtf).html).toBe('<p>kept</p>')
  })

  test('escaped braces and backslashes are literal characters', () => {
    const rtf = '{\\rtf1\\fromhtml1{\\*\\htmltag <style>}a \\{ b: "c\\\\d" \\}{\\*\\htmltag </style>}}'
    expect(deEncapsulateRtf(rtf).html).toBe('<style>a { b: "c\\d" }</style>')
  })

  test('plain RTF gives text, with paragraphs and tabs', () => {
    const rtf = '{\\rtf1\\ansi{\\fonttbl{\\f0 Times New Roman;}}\\f0 First line\\par Second\\tab column\\line third}'
    expect(deEncapsulateRtf(rtf)).toEqual({ html: '', text: 'First line\nSecond\tcolumn\nthird' })
  })

  test('typographic characters written as control words', () => {
    const rtf = '{\\rtf1 \\lquote a\\rquote  \\ldblquote b\\rdblquote  \\bullet  \\endash  \\emdash }'
    // The space after a control word only ends the word; a second one is text.
    expect(deEncapsulateRtf(rtf).text).toBe('\u2018a\u2019 \u201cb\u201d \u2022 \u2013 \u2014')
  })

  test('8-bit characters are read in the code page the RTF names', () => {
    expect(deEncapsulateRtf("{\\rtf1\\ansi\\ansicpg1252 caf\\'e9}").text).toBe('café')
    expect(deEncapsulateRtf("{\\rtf1\\ansi\\ansicpg1251 \\'cf\\'f0\\'e8}").text).toBe('При')
    // Two-byte characters arrive as two escapes and must be decoded together.
    expect(deEncapsulateRtf("{\\rtf1\\ansi\\ansicpg932 \\'93\\'fa\\'96\\'7b}").text).toBe('日本')
  })

  test('the code page in the RTF beats the one the caller suggests', () => {
    expect(deEncapsulateRtf("{\\rtf1\\ansicpg1251 \\'e4}", 1252).text).toBe('д')
    expect(deEncapsulateRtf("{\\rtf1 \\'e4}", 1251).text).toBe('д')
  })

  test('a Unicode character is shown once, not followed by its fallback', () => {
    // Each \\uN is followed by a stand-in for readers that cannot show it.
    expect(deEncapsulateRtf("{\\rtf1\\ansi\\ansicpg1252 caf\\u233\\'e9 au lait}").text).toBe('café au lait')
    expect(deEncapsulateRtf('{\\rtf1 \\u8364?5}').text).toBe('€5')
    expect(deEncapsulateRtf("{\\rtf1\\uc2 \\u26085\\'93\\'fa!}").text).toBe('日!')
    expect(deEncapsulateRtf('{\\rtf1\\uc0 \\u233 e}').text).toBe('ée')
  })

  test('characters above the basic plane arrive as two halves and come out whole', () => {
    // U+1F600 as a surrogate pair of negative 16-bit values, as Word writes it.
    expect(deEncapsulateRtf('{\\rtf1 \\u-10179?\\u-8704?}').text).toBe('\u{1F600}')
  })

  test('a fallback ends at the end of its group, without eating what follows', () => {
    expect(deEncapsulateRtf('{\\rtf1 {\\u233}b}').text).toBe('éb')
  })

  test('damaged or hostile RTF ends without hanging or throwing', () => {
    const samples = [
      '{\\rtf1 unclosed {{{{ groups',
      '{\\rtf1 }}}}} too many closes \\par text',
      "{\\rtf1 \\'zz bad hex \\'",
      '{\\rtf1 \\u999999999999 \\uc-5 \\u',
      '{\\rtf1 \\',
      '{\\rtf1 ' + '{'.repeat(50000) + 'deep' + '}'.repeat(50000) + '}',
      '{\\rtf1 ' + '\\u233'.repeat(20000) + '}',
    ]
    for (const rtf of samples) {
      const started = Date.now()
      expect(() => deEncapsulateRtf(rtf)).not.toThrow()
      expect(Date.now() - started).toBeLessThan(2000)
    }
  })
})
