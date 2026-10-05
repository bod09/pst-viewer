import { describe, expect, test } from 'vitest'
import { categoryForExt, categoryFromNameMime, detectType } from '../../src/lib/detectType'
import { PNG } from '../support/fixtures.mjs'

const hex = (s: string, pad = 16) => {
  const bytes = new Uint8Array(Math.max(pad, s.length / 2))
  for (let i = 0; i < s.length / 2; i++) bytes[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16)
  return bytes
}
const ascii = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0))

describe('detectType', () => {
  test('the bytes win over a misleading name and type', () => {
    expect(detectType(PNG, 'notes.txt', 'text/plain')).toEqual({ ext: 'png', mime: 'image/png', category: 'image' })
    expect(detectType(ascii('%PDF-1.7 rest of file'), 'photo.jpg', 'image/jpeg')).toEqual({
      ext: 'pdf',
      mime: 'application/pdf',
      category: 'pdf',
    })
  })

  test.each([
    ['FFD8FFE000104A464946', 'jpg', 'image'],
    ['474946383961', 'gif', 'image'],
    ['424D', 'bmp', 'image'],
    ['49492A00', 'tif', 'image'],
    ['377ABCAF271C', '7z', 'archive'],
    ['526172211A07', 'rar', 'archive'],
    ['1F8B08', 'gz', 'archive'],
    ['494433', 'mp3', 'audio'],
    ['4F676753', 'ogg', 'audio'],
    ['664C6143', 'flac', 'audio'],
    ['1A45DFA3', 'mkv', 'video'],
    ['7B5C72746631', 'rtf', 'text'],
  ])('signature %s is %s', (signature, ext, category) => {
    const got = detectType(hex(signature), 'file', '')
    expect([got.ext, got.category]).toEqual([ext, category])
  })

  test('container formats are told apart by their inner tag', () => {
    const riff = (tag: string) => new Uint8Array([...ascii('RIFF'), 0, 0, 0, 0, ...ascii(tag)])
    expect(detectType(riff('WEBP'), 'x', '').ext).toBe('webp')
    expect(detectType(riff('WAVE'), 'x', '').ext).toBe('wav')
    expect(detectType(riff('AVI '), 'x', '').ext).toBe('avi')
    const ftyp = (brand: string) => new Uint8Array([0, 0, 0, 24, ...ascii('ftyp'), ...ascii(brand)])
    expect(detectType(ftyp('isom'), 'x', '').ext).toBe('mp4')
    expect(detectType(ftyp('qt  '), 'x', '').ext).toBe('mov')
    expect(detectType(ftyp('M4A '), 'x', '').ext).toBe('m4a')
  })

  test('a zip signature needs the name to tell an office file from an archive', () => {
    const zip = hex('504B0304')
    expect(detectType(zip, 'report.docx', '').category).toBe('office')
    expect(detectType(zip, 'sheet.XLSX', '').ext).toBe('xlsx')
    expect(detectType(zip, 'bundle.zip', '')).toEqual({ ext: 'zip', mime: 'application/zip', category: 'archive' })
    expect(detectType(zip, 'unknown.bin', '').ext).toBe('zip')
  })

  test('an OLE signature needs the name to tell word, excel and a message apart', () => {
    const ole = hex('D0CF11E0A1B11AE1')
    expect(detectType(ole, 'old.xls', '')).toMatchObject({ ext: 'xls', category: 'office' })
    expect(detectType(ole, 'mail.msg', '')).toMatchObject({ ext: 'msg', category: 'email' })
    expect(detectType(ole, 'mystery', '')).toMatchObject({ ext: 'doc', category: 'office' })
  })

  test('readable bytes are text, keeping a text extension', () => {
    expect(detectType(ascii('name,count\nzebra,3\n'), 'data.csv', '')).toEqual({
      ext: 'csv',
      mime: 'text/csv',
      category: 'text',
    })
    expect(detectType(ascii('just some words'), 'README', '')).toMatchObject({ ext: 'txt', category: 'text' })
  })

  test('with no bytes, the declared type is used, then the name', () => {
    expect(detectType(null, 'whatever', 'application/pdf')).toMatchObject({ ext: 'pdf', category: 'pdf' })
    expect(detectType(null, 'x', 'IMAGE/PNG; name=x')).toMatchObject({ ext: 'png', category: 'image' })
    expect(detectType(null, 'clip.MOV', '')).toMatchObject({ ext: 'mov', mime: 'video/quicktime', category: 'video' })
    expect(detectType(null, 'odd.xyz', '')).toEqual({ ext: 'xyz', mime: 'application/octet-stream', category: 'other' })
    expect(detectType(null, 'noext', '')).toEqual({ ext: '', mime: 'application/octet-stream', category: 'other' })
  })

  test('an image type this app does not know is offered as a download, not shown as a broken picture', () => {
    expect(detectType(null, 'drawing', 'image/x-emf')).toEqual({ ext: '', mime: 'image/x-emf', category: 'other' })
    expect(detectType(null, 'photo', 'image/heic').category).toBe('other')
    expect(categoryFromNameMime('drawing', 'image/x-emf')).toBe('other')
    // The file name, when it has an extension, is still believed.
    expect(detectType(null, 'drawing.png', 'image/x-emf')).toMatchObject({ ext: 'png', category: 'image' })
  })

  test.each(['image/(', 'image/../../evil.exe', 'image/a b', 'image/<script>', 'image/.*', 'image/', `image/${'x'.repeat(50)}`])(
    'a declared type of %j does not put anything odd in the file extension',
    (mime) => {
      expect(detectType(null, 'picture', mime).ext).toMatch(/^[a-z0-9]*$/)
      expect(detectType(new Uint8Array([0, 1, 2, 3, 0, 255]), 'picture', mime).ext).toMatch(/^[a-z0-9]*$/)
    },
  )

  test('binary bytes with no known signature fall through to the name', () => {
    const binary = new Uint8Array([0, 1, 2, 3, 0, 255, 254, 0])
    expect(detectType(binary, 'data.bin', '')).toMatchObject({ ext: 'bin', category: 'other' })
  })
})

describe('categories', () => {
  test('by extension', () => {
    expect(['pdf', 'eml', 'msg', 'png', 'txt', 'mp3', 'mp4', 'docx', 'zip', 'exe'].map(categoryForExt)).toEqual([
      'pdf', 'email', 'email', 'image', 'text', 'audio', 'video', 'office', 'archive', 'other',
    ])
  })

  test('by name first, then by declared type', () => {
    expect(categoryFromNameMime('photo.JPG', 'application/octet-stream')).toBe('image')
    expect(categoryFromNameMime('noext', 'image/png')).toBe('image')
    expect(categoryFromNameMime('noext', 'image/x-unknown')).toBe('other')
    expect(categoryFromNameMime('noext', 'audio/x-thing')).toBe('audio')
    expect(categoryFromNameMime('noext', 'video/x-thing')).toBe('video')
    expect(categoryFromNameMime('noext', 'text/x-thing')).toBe('text')
    expect(categoryFromNameMime('noext', 'message/rfc822')).toBe('email')
    expect(categoryFromNameMime('noext', 'application/pdf')).toBe('pdf')
    expect(categoryFromNameMime('noext', '')).toBe('other')
  })
})
