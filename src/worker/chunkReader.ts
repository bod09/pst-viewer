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
 * Slabs are kept in an LRU (Map insertion order); concurrent requests for a
 * slab that is still loading share the same fetch.
 *
 * The budget is shared by every open mailbox rather than granted per file:
 * someone comparing five mailboxes should not be charged five times over for
 * what is only a read cache. It is also sized to the machine, because the
 * devices most likely to run short of memory are the ones least able to
 * spare a nine-figure cache.
 *
 * It shrinks once nothing is being indexed. Indexing reads the file end to
 * end, where reading ahead pays for itself; afterwards the reads are small and
 * scattered, and a cache holding a fraction of a multi-gigabyte file rarely
 * has the wanted slab anyway. Opening another mailbox raises it again for the
 * duration of that pass.
 */

const SLAB_SIZE = 256 * 1024

/** What this machine can spare for reading, while a mailbox is being read. */
function deviceBudget(): number {
  // navigator.deviceMemory is a coarse, capped hint (0.25-8, absent on
  // Firefox and Safari). Unknown is treated as roomy: the read cache is what
  // makes a large mailbox usable, so it is not given up on a guess.
  const gb = (navigator as unknown as { deviceMemory?: number }).deviceMemory
  if (!gb) return 128 * 1024 * 1024
  if (gb <= 2) return 24 * 1024 * 1024
  if (gb <= 4) return 48 * 1024 * 1024
  return 128 * 1024 * 1024
}

/** Indexing passes running right now. */
let readingPasses = 0

/** Total slab memory across every open file. */
function slabBudget(): number {
  const full = deviceBudget()
  return readingPasses > 0 ? full : Math.max(8 * 1024 * 1024, Math.floor(full / 4))
}

/** Called around an indexing pass, which reads the whole file and is the one
 *  time reading ahead is worth the memory. */
export function beginReadingPass(): void {
  readingPasses++
}

export function endReadingPass(): void {
  readingPasses = Math.max(0, readingPasses - 1)
  // Hand the difference back now rather than waiting for the next read.
  if (readingPasses === 0) evictToBudget()
}

/**
 * Every live reader's slabs, in one LRU keyed `${readerId}:${slabIndex}`, so
 * eviction can take the globally coldest slab instead of each file policing
 * its own share.
 */
const slabs = new Map<string, Uint8Array>()
let slabBytes = 0
let nextReaderId = 0

function evictToBudget(): void {
  const budget = slabBudget()
  if (slabBytes <= budget) return
  for (const [key, bytes] of slabs) {
    slabs.delete(key)
    slabBytes -= bytes.byteLength
    if (slabBytes <= budget) return
  }
}

/** A reader that can also give its cached bytes back on request. */
export interface ChunkedReader extends ReadFileApi {
  /** Drop this file's cached slabs. Pure cache: reads simply refetch. */
  trim(): void
}

export function makeChunkedReader(file: File): ChunkedReader {
  const id = String(nextReaderId++)
  const keyOf = (index: number) => `${id}:${index}`
  const owned = new Set<number>()
  const loading = new Map<number, Promise<Uint8Array>>()
  const lastSlab = Math.floor(Math.max(file.size - 1, 0) / SLAB_SIZE)

  const cache = {
    has: (index: number) => slabs.has(keyOf(index)),
    get: (index: number) => slabs.get(keyOf(index)),
    set: (index: number, bytes: Uint8Array) => {
      slabs.set(keyOf(index), bytes)
      owned.add(index)
      slabBytes += bytes.byteLength
      evictToBudget()
    },
    touch: (index: number, bytes: Uint8Array) => {
      // Re-insert to move this slab to the warm end of the LRU.
      slabs.delete(keyOf(index))
      slabs.set(keyOf(index), bytes)
    },
    drop: () => {
      for (const index of owned) {
        const key = keyOf(index)
        const bytes = slabs.get(key)
        if (bytes) {
          slabs.delete(key)
          slabBytes -= bytes.byteLength
        }
      }
      owned.clear()
    },
  }

  const slab = (index: number): Promise<Uint8Array> => {
    const hit = cache.get(index)
    if (hit) {
      cache.touch(index, hit)
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
        cache.set(index, bytes) // evicts globally if this puts us over budget
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
        const cold = !cache.has(index)
        const bytes = await slab(index)
        // Read-ahead: parser access is largely sequential (index pages, then
        // messages in file order), so a cold slab predicts its neighbour will
        // be wanted next. Fetch it in the background while parsing continues.
        if (cold && index < lastSlab && !cache.has(index + 1) && !loading.has(index + 1)) {
          slab(index + 1).catch(() => {})
        }
        const rel = pos - index * SLAB_SIZE
        if (rel >= bytes.byteLength) break
        const n = Math.min(end - pos, bytes.byteLength - rel)
        out.set(bytes.subarray(rel, rel + n), produced)
        produced += n
        pos += n
      }
      return produced
    },
    trim: () => {
      cache.drop()
      loading.clear()
    },
    close: async () => {
      cache.drop()
      loading.clear()
    },
  }
}
