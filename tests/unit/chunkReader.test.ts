import { afterEach, describe, expect, test, vi } from 'vitest'
import { beginReadingPass, endReadingPass, makeChunkedReader } from '../../src/worker/chunkReader'

const SLAB = 256 * 1024

/** Bytes whose value depends on their position, so a misplaced read shows. */
function patterned(length: number): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(length)
  for (let i = 0; i < length; i++) out[i] = (i * 31 + (i >>> 8) * 7 + (i >>> 16)) & 0xff
  return out
}

async function read(reader: ReturnType<typeof makeChunkedReader>, position: number, length: number) {
  const buffer = new ArrayBuffer(length + 16)
  const produced = await reader.readFile(buffer, 8, length, position)
  return { produced, bytes: new Uint8Array(buffer, 8, produced), whole: new Uint8Array(buffer) }
}

afterEach(() => vi.restoreAllMocks())

describe('makeChunkedReader', () => {
  const data = patterned(SLAB * 3 + 12345)
  const file = new File([data], 'box.pst')

  test.each([
    ['the start', 0, 100],
    ['inside one slab', 5000, 4096],
    ['up to a slab edge', SLAB - 512, 512],
    ['across a slab edge', SLAB - 100, 300],
    ['across two edges', SLAB - 10, SLAB + 20],
    ['the last bytes', data.length - 77, 77],
    ['the whole file', 0, data.length],
    ['nothing', 1000, 0],
  ])('reads %s exactly', async (_what, position, length) => {
    const reader = makeChunkedReader(file)
    const got = await read(reader, position, length)
    expect(got.produced).toBe(length)
    expect(Buffer.from(got.bytes).equals(Buffer.from(data.subarray(position, position + length)))).toBe(true)
    await reader.close()
  })

  test('writes only inside the part of the buffer it was given', async () => {
    const reader = makeChunkedReader(file)
    const got = await read(reader, SLAB - 4, 8)
    const untouched = [0, 0, 0, 0, 0, 0, 0, 0]
    expect([...got.whole.subarray(0, 8)]).toEqual(untouched)
    expect([...got.whole.subarray(16)]).toEqual(untouched)
    await reader.close()
  })

  test('a read past the end returns what there is', async () => {
    const reader = makeChunkedReader(file)
    const tail = await read(reader, data.length - 10, 50)
    expect(tail.produced).toBe(10)
    expect([...tail.bytes]).toEqual([...data.subarray(data.length - 10)])
    expect((await read(reader, data.length + 1000, 10)).produced).toBe(0)
    await reader.close()
  })

  test('many scattered reads all match the file', async () => {
    const reader = makeChunkedReader(file)
    let seed = 12345
    const random = (max: number) => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff
      return seed % max
    }
    const reads = Array.from({ length: 300 }, () => {
      const position = random(data.length)
      return { position, length: random(Math.min(70000, data.length - position)) }
    })
    // Issued together, so several ask for a slab that is still loading.
    const results = await Promise.all(reads.map((r) => read(reader, r.position, r.length)))
    for (const [i, r] of reads.entries()) {
      const want = data.subarray(r.position, r.position + r.length)
      expect(Buffer.from(results[i].bytes).equals(Buffer.from(want)), `read ${i}`).toBe(true)
    }
    await reader.close()
  })

  test('an empty file reads as nothing', async () => {
    const reader = makeChunkedReader(new File([], 'empty.pst'))
    expect((await read(reader, 0, 10)).produced).toBe(0)
    await reader.close()
  })

  test('each slab is fetched from the file once, however often it is read', async () => {
    const small = new File([patterned(SLAB + 10)], 'small.pst')
    const slice = vi.spyOn(small, 'slice')
    const reader = makeChunkedReader(small)
    for (let i = 0; i < 50; i++) await read(reader, i * 100, 64)
    await Promise.all(Array.from({ length: 20 }, (_, i) => read(reader, SLAB - 5 + i, 4)))
    // Two slabs in the file: the one asked for, and its neighbour read ahead.
    expect(slice.mock.calls.map((c) => c[0]).sort()).toEqual([0, SLAB])
    await reader.close()
  })

  test('after its cache is dropped, a reader simply reads again', async () => {
    const reader = makeChunkedReader(file)
    const before = await read(reader, SLAB - 50, 100)
    reader.trim()
    const after = await read(reader, SLAB - 50, 100)
    expect([...after.bytes]).toEqual([...before.bytes])
    await reader.close()
    expect([...(await read(reader, SLAB - 50, 100)).bytes]).toEqual([...before.bytes])
  })

  test('a failed read is not remembered: the next attempt can succeed', async () => {
    const flaky = new File([patterned(1000)], 'flaky.pst')
    const realSlice = flaky.slice.bind(flaky)
    let fail = true
    vi.spyOn(flaky, 'slice').mockImplementation((...args) => {
      const blob = realSlice(...args)
      if (fail) blob.arrayBuffer = () => Promise.reject(new DOMException('gone', 'NotReadableError'))
      return blob
    })
    const reader = makeChunkedReader(flaky)
    await expect(read(reader, 0, 10)).rejects.toThrow('gone')
    fail = false
    expect((await read(reader, 0, 10)).produced).toBe(10)
    await reader.close()
  })

  test('reads stay right after the shared cache has had to evict', async () => {
    // 60 MB across three files, against a 32 MB budget once the pass ends, so
    // most of what was read is evicted. (The budget itself is private; what a
    // caller can see, and what matters, is that every later read is still right.)
    const size = 20 * 1024 * 1024
    const big = patterned(size)
    const files = ['a', 'b', 'c'].map((name) => new File([big], `${name}.pst`))
    const readers = files.map(makeChunkedReader)
    beginReadingPass()
    for (const reader of readers) {
      for (let pos = 0; pos < size; pos += SLAB) await read(reader, pos, 16)
    }
    endReadingPass()
    // Whatever was evicted is read again on demand, and still right.
    for (const reader of readers) {
      for (const position of [0, size / 2 + 3, size - 100]) {
        const got = await read(reader, position, 100)
        expect(Buffer.from(got.bytes).equals(Buffer.from(big.subarray(position, position + 100)))).toBe(true)
      }
    }
    for (const reader of readers) await reader.close()
  })
})
