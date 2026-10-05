import { describe, expect, test } from 'vitest'
import { parseTnef } from '../../src/lib/tnef'

/** Build a winmail.dat stream from attributes, the way Outlook lays one out. */
class Tnef {
  private parts: Uint8Array[] = [new Uint8Array([0x78, 0x9f, 0x3e, 0x22, 0x01, 0x00])] // signature + key

  attr(level: 1 | 2, id: number, data: Uint8Array): this {
    const head = new Uint8Array(9)
    const dv = new DataView(head.buffer)
    dv.setUint8(0, level)
    dv.setUint32(1, id, true)
    dv.setUint32(5, data.length, true)
    this.parts.push(head, data, new Uint8Array(2)) // + checksum, which the reader skips
    return this
  }

  bytes(): ArrayBuffer {
    return new Uint8Array(Buffer.concat(this.parts)).buffer
  }
}

const u32 = (n: number) => new Uint8Array(new Uint32Array([n]).buffer)
const ansi = (s: string) => Uint8Array.from(s + '\0', (c) => c.charCodeAt(0))
const text = (data: ArrayBuffer) => new TextDecoder().decode(data)

// Attribute ids (type in the high word, id in the low word).
const BODY = 0x0002800c
const OEM_CODEPAGE = 0x00069007
const REND_DATA = 0x00069002
const TITLE = 0x00018010
const DATA = 0x0006800f
const ATTACHMENT_PROPS = 0x00069005

/** One Unicode string property, as it appears in an attachment's MAPI block. */
function unicodeProp(tag: number, value: string): Uint8Array {
  const str = Buffer.from(value + '\0', 'utf16le')
  const pad = (4 - (str.length % 4)) % 4
  const out = Buffer.alloc(4 + 4 + 4 + str.length + pad)
  out.writeUInt16LE(0x001f, 0) // PT_UNICODE
  out.writeUInt16LE(tag, 2)
  out.writeUInt32LE(1, 4) // one value
  out.writeUInt32LE(str.length, 8)
  str.copy(out, 12)
  return new Uint8Array(out)
}
const props = (...list: Uint8Array[]) => new Uint8Array(Buffer.concat([u32(list.length), ...list]))

describe('parseTnef', () => {
  test('anything that is not TNEF is refused', () => {
    expect(parseTnef(new ArrayBuffer(0))).toBeNull()
    expect(parseTnef(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]).buffer)).toBeNull()
  })

  test('a body and two attachments are recovered', () => {
    const tnef = new Tnef()
      .attr(1, BODY, ansi('The real message text.'))
      .attr(2, REND_DATA, new Uint8Array(14))
      .attr(2, TITLE, ansi('REPORT~1.PDF'))
      .attr(2, DATA, ansi('first file').subarray(0, 10))
      .attr(2, REND_DATA, new Uint8Array(14))
      .attr(2, TITLE, ansi('notes.txt'))
      .attr(2, DATA, ansi('second file').subarray(0, 11))
    const result = parseTnef(tnef.bytes())
    expect(result?.bodyText).toBe('The real message text.')
    expect(result?.attachments.map((a) => [a.name, text(a.data)])).toEqual([
      ['REPORT~1.PDF', 'first file'],
      ['notes.txt', 'second file'],
    ])
  })

  test('the long file name and type beat the short 8.3 name', () => {
    const tnef = new Tnef()
      .attr(2, REND_DATA, new Uint8Array(14))
      .attr(2, TITLE, ansi('QUARTE~1.PDF'))
      .attr(2, DATA, new Uint8Array([1, 2, 3]))
      .attr(
        2,
        ATTACHMENT_PROPS,
        props(unicodeProp(0x3707, 'Quarterly Report – Final.pdf'), unicodeProp(0x370e, 'application/pdf')),
      )
    expect(parseTnef(tnef.bytes())?.attachments).toEqual([
      { name: 'Quarterly Report – Final.pdf', mime: 'application/pdf', data: new Uint8Array([1, 2, 3]).buffer },
    ])
  })

  test('8-bit names are read in the code page the stream declares', () => {
    const cp1251 = new Uint8Array([0xee, 0xf2, 0xf7, 0xb8, 0xf2, 0x2e, 0x74, 0x78, 0x74, 0x00]) // "отчёт.txt"
    const tnef = new Tnef()
      .attr(1, OEM_CODEPAGE, new Uint8Array([...u32(1251), ...u32(0)]))
      .attr(2, REND_DATA, new Uint8Array(14))
      .attr(2, TITLE, cp1251)
      .attr(2, DATA, new Uint8Array([9]))
    expect(parseTnef(tnef.bytes())?.attachments[0].name).toBe('отчёт.txt')
  })

  test('an attachment with no data is left out', () => {
    const tnef = new Tnef().attr(2, REND_DATA, new Uint8Array(14)).attr(2, TITLE, ansi('empty.txt'))
    expect(parseTnef(tnef.bytes())?.attachments).toEqual([])
  })

  test('a stream cut short keeps what came before the cut', () => {
    const whole = new Uint8Array(
      new Tnef()
        .attr(2, REND_DATA, new Uint8Array(14))
        .attr(2, TITLE, ansi('kept.txt'))
        .attr(2, DATA, ansi('kept'))
        .attr(2, REND_DATA, new Uint8Array(14))
        .attr(2, TITLE, ansi('lost.txt'))
        .attr(2, DATA, new Uint8Array(500))
        .bytes(),
    )
    const cut = whole.slice(0, whole.length - 300).buffer
    expect(parseTnef(cut)?.attachments.map((a) => a.name)).toEqual(['kept.txt'])
  })

  test('lengths that lie about the size of the stream do not crash the reader', () => {
    const lying = new Uint8Array(new Tnef().attr(2, DATA, new Uint8Array(8)).bytes())
    new DataView(lying.buffer).setUint32(6 + 5, 0xffffffff, true)
    expect(parseTnef(lying.buffer)).toEqual({ bodyText: null, attachments: [] })

    // A property block claiming far more entries, and longer values, than it holds.
    const badProps = new Uint8Array(Buffer.concat([u32(999999), unicodeProp(0x3707, 'x')]))
    new DataView(badProps.buffer).setUint32(12, 0x7fffffff, true)
    const tnef = new Tnef()
      .attr(2, REND_DATA, new Uint8Array(14))
      .attr(2, TITLE, ansi('short.txt'))
      .attr(2, DATA, new Uint8Array([1]))
      .attr(2, ATTACHMENT_PROPS, badProps)
    expect(parseTnef(tnef.bytes())?.attachments[0].name).toBe('short.txt')
  })
})
