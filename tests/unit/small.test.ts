import { describe, expect, test } from 'vitest'
import { filterAccepted, isAcceptedFile } from '../../src/lib/files'
import { formatBytes, formatDate, formatDateShort } from '../../src/lib/format'
import iconv, { decode } from '../../src/lib/iconv-lite-shim'
import { isCfbFile } from '../../src/worker/eml'
import { fingerprintOf, getCachedIndex, putCachedIndex } from '../../src/worker/indexCache'
import { mailEml, mailMsg } from '../support/fixtures.mjs'

describe('accepted files', () => {
  test('mailboxes, messages and archives, whatever the case of the name', () => {
    expect(['a.pst', 'B.OST', 'c.Msg', 'd.eml', 'e.ZIP'].every(isAcceptedFile)).toBe(true)
    expect(['a.pdf', 'pst', 'a.pst.txt', 'a.emlx', ''].some(isAcceptedFile)).toBe(false)
  })

  test('other files are filtered out of a drop', () => {
    const files = ['keep.pst', 'skip.docx', 'keep.eml'].map((name) => new File(['x'], name))
    expect(filterAccepted(files).map((f) => f.name)).toEqual(['keep.pst', 'keep.eml'])
  })
})

describe('formatBytes', () => {
  test.each([
    [0, '0 B'],
    [-5, '0 B'],
    [Number.NaN, '0 B'],
    [Number.POSITIVE_INFINITY, '0 B'],
    [1, '1 B'],
    [1023, '1023 B'],
    [1024, '1.0 KB'],
    [1536, '1.5 KB'],
    [150 * 1024, '150 KB'],
    [5 * 1024 * 1024, '5.0 MB'],
    [9.5 * 1024 ** 3, '9.5 GB'],
    [3 * 1024 ** 4, '3.0 TB'],
    [5000 * 1024 ** 4, '5000 TB'],
  ])('%d is %s', (bytes, expected) => {
    expect(formatBytes(bytes)).toBe(expected)
  })
})

describe('dates', () => {
  test('a missing or impossible date is shown as nothing, not as "Invalid Date"', () => {
    for (const value of [null, undefined, Number.NaN]) {
      expect(formatDate(value)).toBe('')
      expect(formatDateShort(value)).toBe('')
    }
  })

  test('a real date is shown', () => {
    const march = new Date(2024, 2, 12, 10, 15).getTime()
    expect(formatDate(march)).toContain('2024')
    expect(formatDateShort(march)).toContain('2024')
    // Today shows as a time, without the year.
    expect(formatDateShort(Date.now())).not.toContain(String(new Date().getFullYear()))
  })
})

describe('iconv-lite stand-in', () => {
  test.each([
    ['windows-1252', [0x63, 0x61, 0x66, 0xe9], 'café'],
    ['cp1252', [0x80], '€'],
    ['1251', [0xcf, 0xf0, 0xe8], 'При'],
    ['win1250', [0x9a], 'š'],
    ['cp932', [0x93, 0xfa, 0x96, 0x7b], '日本'],
    ['936', [0xd6, 0xd0], '中'],
    ['949', [0xc7, 0xd1], '한'],
    ['950', [0xa4, 0xa4], '中'],
    ['28592', [0xb1], 'ą'],
    ['65001', [0xc3, 0xa9], 'é'],
    ['utf-8', [0xe2, 0x82, 0xac], '€'],
    ['20866', [0xf0], 'П'],
  ])('%s', (encoding, bytes, expected) => {
    expect(decode(new Uint8Array(bytes), encoding)).toBe(expected)
  })

  test('an encoding nobody knows falls back to UTF-8 instead of failing', () => {
    expect(decode(new Uint8Array([0xc3, 0xa9]), 'x-not-a-real-encoding')).toBe('é')
    expect(decode(new Uint8Array([0x41]), '')).toBe('A')
  })

  test('encode writes UTF-8', () => {
    expect([...iconv.encode('é')]).toEqual([0xc3, 0xa9])
  })
})

describe('isCfbFile', () => {
  test('tells a .msg from anything else by its first bytes', () => {
    expect(isCfbFile(mailMsg().slice().buffer)).toBe(true)
    expect(isCfbFile(mailEml().slice().buffer)).toBe(false)
    expect(isCfbFile(new ArrayBuffer(0))).toBe(false)
    expect(isCfbFile(new Uint8Array([0xd0, 0xcf, 0x11]).buffer)).toBe(false)
  })
})

describe('index cache', () => {
  test('a file is recognised by name, size and time of last change', () => {
    const a = new File(['abc'], 'box.pst', { lastModified: 1000 })
    expect(fingerprintOf(a)).toBe('box.pst|3|1000')
    expect(fingerprintOf(new File(['abc'], 'box.pst', { lastModified: 1000 }))).toBe(fingerprintOf(a))
    expect(fingerprintOf(new File(['abcd'], 'box.pst', { lastModified: 1000 }))).not.toBe(fingerprintOf(a))
    expect(fingerprintOf(new File(['abc'], 'box.pst', { lastModified: 2000 }))).not.toBe(fingerprintOf(a))
  })

  test('with nowhere to store it, reading finds nothing and writing reports that it did not happen', async () => {
    // No IndexedDB here, which is also how a browser behaves in some private modes.
    expect(await getCachedIndex('box.pst|3|1000')).toBeUndefined()
    expect(await putCachedIndex('box.pst|3|1000', [], [])).toBe(false)
  })
})
