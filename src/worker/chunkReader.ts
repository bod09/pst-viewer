import type { ReadFileApi } from '@hiraokahypertools/pst-extractor'

/**
 * A caching random-access reader over a File.
 *
 * The parser asks for tiny, clustered pieces one await at a time: 512 byte or
 * 4 KB index pages while opening, then small blocks per message. Serving each
 * request with its own Blob.slice().arrayBuffer() costs a round trip to the
 * browser's file thread, so opening a large mailbox issues hundreds of
 * thousands of micro-reads. Reading the file in larger slabs and serving
 * requests from an in-memory cache collapses that to one fetch per slab.
 *
 * Slabs are kept in a small LRU (Map insertion order); concurrent requests
 * for a slab that is still loading share the same fetch.
 */

const SLAB_SIZE = 256 * 1024
const MAX_SLABS = 512 // 128 MiB cap per open file

export function makeChunkedReader(file: File): ReadFileApi {
  const cache = new Map<number, Uint8Array>()
  const loading = new Map<number, Promise<Uint8Array>>()

  const slab = (index: number): Promise<Uint8Array> => {
    const hit = cache.get(index)
    if (hit) {
      // Refresh the LRU position.
      cache.delete(index)
      cache.set(index, hit)
      return Promise.resolve(hit)
    }
    const inflight = loading.get(index)
    if (inflight) return inflight
    const start = index * SLAB_SIZE
    const p = file
      .slice(start, Math.min(start + SLAB_SIZE, file.size))
      .arrayBuffer()
      .then((ab) => {
        const bytes = new Uint8Array(ab)
        loading.delete(index)
        cache.set(index, bytes)
        if (cache.size > MAX_SLABS) {
          const oldest = cache.keys().next().value
          if (oldest !== undefined) cache.delete(oldest)
        }
        return bytes
      })
      .catch((err: unknown) => {
        loading.delete(index)
        throw err
      })
    loading.set(index, p)
    return p
  }

  return {
    readFile: async (buffer, offset, length, position) => {
      const out = new Uint8Array(buffer, offset, length)
      const end = Math.min(position + length, file.size)
      let produced = 0
      for (let pos = position; pos < end; ) {
        const index = Math.floor(pos / SLAB_SIZE)
        const bytes = await slab(index)
        const rel = pos - index * SLAB_SIZE
        if (rel >= bytes.byteLength) break
        const n = Math.min(end - pos, bytes.byteLength - rel)
        out.set(bytes.subarray(rel, rel + n), produced)
        produced += n
        pos += n
      }
      return produced
    },
    close: async () => {
      cache.clear()
      loading.clear()
    },
  }
}
