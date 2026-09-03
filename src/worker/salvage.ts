import { openPst, type IPSTFile, type ReadFileApi } from '@hiraokahypertools/pst-extractor'
import { makeChunkedReader } from './chunkReader'

/**
 * Built-in recovery for damaged PST/OST files.
 *
 * When a file's header or index b-trees are broken, the parser cannot walk to
 * the data even though most of it is still present. This module scans the
 * whole file for surviving b-tree leaf pages (they are fixed-size and carry a
 * verifiable signature), then rebuilds fresh node/block b-trees and a fresh
 * header in an in-memory overlay. The original file is never modified; a
 * layered reader serves the synthetic header and pages while all data reads
 * fall through to the real file. The unmodified parser then opens the overlay
 * as if it were a healthy file, and its existing per-message error handling
 * accounts for whatever is genuinely lost.
 *
 * Covers Unicode PSTs (version 0x17) and 4K OSTs (0x24). Ancient ANSI files
 * (0x0e) are not salvaged.
 */

interface Layout {
  version: number
  pageSize: number
  itemCountAt: number
  levelAt: number
  /** Trailer offsets within the page. */
  ptypeAt: number
  wSigAt: number
  bidAt: number
  /** Entry capacity per synthesized page. */
  maxNbt: number
  maxBbt: number
  maxTbl: number
  /** Largest believable on-disk block size for this format. */
  maxBlock: number
}

const V17: Layout = {
  version: 0x17,
  pageSize: 512,
  itemCountAt: 0x1e8,
  levelAt: 0x1eb,
  ptypeAt: 496,
  wSigAt: 498,
  bidAt: 504,
  maxNbt: 15,
  maxBbt: 20,
  maxTbl: 20,
  maxBlock: 8192,
}

const V24: Layout = {
  version: 0x24,
  pageSize: 4096,
  itemCountAt: 0xfd8,
  levelAt: 0xfdd,
  ptypeAt: 0xfe8,
  wSigAt: 0xfea,
  bidAt: 0xff0,
  maxNbt: 126,
  maxBbt: 169,
  maxTbl: 169,
  maxBlock: 65535,
}

const PTYPE_BBT = 0x80
const PTYPE_NBT = 0x81
const NID_MESSAGE_STORE = 0x21

const NBT_ENTRY = 32
const BBT_ENTRY = 24
const TBL_ENTRY = 24

/** Real block/node ids stay far below this; anything above is damage. */
const MAX_ID = 1n << 48n

/** Page signature from [MS-PST]: fold of (offset XOR trailer bid) into 16 bits. */
function computeSig(ib: bigint, bid: bigint): number {
  const x = ib ^ bid
  return Number((x >> 16n) & 0xffffn) ^ Number(x & 0xffffn)
}

const u64 = (view: DataView, off: number): bigint => view.getBigUint64(off, true)

interface Carved {
  /** Entry bytes, keyed by id, deduplicated keeping the newest generation. */
  nbt: Map<bigint, Uint8Array>
  bbt: Map<bigint, Uint8Array>
  pages: number
}

/** Scan the file for intact NBT/BBT leaf pages under the given layout. */
async function carve(file: File, L: Layout): Promise<Carved> {
  const nbt = new Map<bigint, Uint8Array>()
  const bbt = new Map<bigint, Uint8Array>()
  const gen = new Map<string, bigint>() // "n:<id>"/"b:<id>" -> page bid it came from
  let pages = 0

  const CHUNK = 8 * 1024 * 1024
  for (let base = 0; base < file.size; base += CHUNK) {
    const ab = await file.slice(base, Math.min(base + CHUNK, file.size)).arrayBuffer()
    const view = new DataView(ab)
    const whole = new Uint8Array(ab)
    for (let off = 0; off + L.pageSize <= ab.byteLength; off += L.pageSize) {
      const ptype = view.getUint8(off + L.ptypeAt)
      if (ptype !== PTYPE_BBT && ptype !== PTYPE_NBT) continue
      if (view.getUint8(off + L.ptypeAt + 1) !== ptype) continue
      if (view.getUint8(off + L.levelAt) !== 0) continue // leaves only
      const cEnt = view.getUint8(off + L.itemCountAt)
      const max = ptype === PTYPE_NBT ? L.maxNbt : L.maxBbt
      if (cEnt < 1 || cEnt > max) continue
      const pageBid = u64(view, off + L.bidAt)
      if (pageBid === 0n) continue
      if (computeSig(BigInt(base + off), pageBid) !== view.getUint16(off + L.wSigAt, true)) continue

      pages++
      const entSize = ptype === PTYPE_NBT ? NBT_ENTRY : BBT_ENTRY
      for (let i = 0; i < cEnt; i++) {
        const e = off + i * entSize
        const id = u64(view, e)
        if (id === 0n) break
        // Plausibility limits kill junk from lucky-looking damaged pages, and
        // keep every id below 2^53 (the parser mixes Long and Number math).
        if (ptype === PTYPE_NBT) {
          const bidData = u64(view, e + 8)
          const bidSub = u64(view, e + 16)
          if (id > 0xffffffffn) continue // node ids are 32-bit
          if (bidData >= MAX_ID || bidSub >= MAX_ID) continue
        } else {
          const ib = u64(view, e + 8)
          const cb = view.getUint16(e + 16, true)
          if (id >= MAX_ID) continue
          if (ib >= BigInt(file.size) || cb === 0 || cb > L.maxBlock) continue
        }
        const key = (ptype === PTYPE_NBT ? 'n:' : 'b:') + id
        const prev = gen.get(key)
        if (prev !== undefined && prev >= pageBid) continue
        gen.set(key, pageBid)
        const bytes = whole.slice(e, e + entSize)
        if (ptype === PTYPE_NBT) nbt.set(id, bytes)
        else bbt.set(id, bytes)
      }
    }
  }
  return { nbt, bbt, pages }
}

/** Build a b-tree (leaves up to a single root) out of fixed-size entry blobs. */
function buildTree(
  L: Layout,
  entries: Uint8Array[],
  entrySize: number,
  perLeaf: number,
  pages: Uint8Array[],
  baseIb: bigint,
  nextBid: { v: bigint },
): { rootIb: bigint; rootBid: bigint } {
  interface Ref {
    btkey: bigint
    bid: bigint
    ib: bigint
  }
  const keyOf = (bytes: Uint8Array) =>
    new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getBigUint64(0, true)

  const emit = (body: Uint8Array[], size: number, level: number): Ref => {
    // The parser's zlib sniff inflates anything starting 0x78 0x9C; dodge by
    // swapping the first two entries when that pattern would appear.
    if (body.length > 1 && body[0][0] === 0x78 && body[0][1] === 0x9c) {
      ;[body[0], body[1]] = [body[1], body[0]]
    }
    const page = new Uint8Array(L.pageSize)
    body.forEach((b, i) => page.set(b, i * size))
    const bid = nextBid.v
    nextBid.v += 4n
    const ib = baseIb + BigInt(pages.length) * BigInt(L.pageSize)
    const view = new DataView(page.buffer)
    view.setUint8(L.itemCountAt, body.length)
    view.setUint8(L.levelAt, level)
    view.setUint8(L.ptypeAt, level === 0 ? 0xff : 0xff) // ptype unread by parser
    view.setBigUint64(L.bidAt, bid, true)
    pages.push(page)
    return { btkey: keyOf(body[0]), bid, ib }
  }

  let level = 0
  let size = entrySize
  let per = perLeaf
  let current = entries
  let refs: Ref[] = []
  for (;;) {
    refs = []
    for (let i = 0; i < current.length; i += per) {
      refs.push(emit(current.slice(i, i + per), size, level))
    }
    if (refs.length === 1) return { rootIb: refs[0].ib, rootBid: refs[0].bid }
    // Encode the refs as interior entries for the next level up.
    current = refs.map((r) => {
      const b = new Uint8Array(TBL_ENTRY)
      const v = new DataView(b.buffer)
      v.setBigUint64(0, r.btkey, true)
      v.setBigUint64(8, r.bid, true)
      v.setBigUint64(16, r.ib, true)
      return b
    })
    size = TBL_ENTRY
    per = L.maxTbl
    level++
  }
}

export interface SalvagePlan {
  reader: ReadFileApi
  layout: Layout
  nodes: number
  blocks: number
  /** Encryption flag written into the synthetic header. */
  usedEnc: number
  /** The flag came from the file's own (intact) header, not a guess. */
  encFromHeader: boolean
}

/** Carve the file and assemble the overlay for one encryption-type guess. */
export async function buildSalvage(file: File, encType: number | null): Promise<SalvagePlan | null> {
  // Prefer the layout the header names; scan both when the header is gone.
  let headerEnc: number | null = null
  let layouts = [V17, V24]
  if (file.size >= 1024) {
    const head = new DataView(await file.slice(0, 1024).arrayBuffer())
    if (head.getUint32(0, false) === 0x2142444e) {
      const ver = head.getUint8(10)
      if (ver === 0x0e) return null // ANSI: not supported
      if (ver === 0x17) layouts = [V17]
      if (ver === 0x24) layouts = [V24]
      const enc = head.getUint8(0x201)
      if (enc === 0 || enc === 1) headerEnc = enc
    }
  }

  let carved: Carved | null = null
  let layout = layouts[0]
  for (const L of layouts) {
    const c = await carve(file, L)
    if (!carved || c.pages > carved.pages) {
      carved = c
      layout = L
    }
  }
  if (!carved) return null

  // Drop nodes whose data/subnode blocks did not survive: keeping them would
  // crash the open outright, while dropping them costs only the affected
  // items (counted by the app's usual per-message error handling).
  const bidsSeen = new Set<bigint>()
  for (const b of carved.bbt.keys()) bidsSeen.add(b & ~1n)
  for (const [nid, bytes] of carved.nbt) {
    const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    const bidData = v.getBigUint64(8, true)
    const bidSub = v.getBigUint64(16, true)
    if (
      (bidData !== 0n && !bidsSeen.has(bidData & ~1n)) ||
      (bidSub !== 0n && !bidsSeen.has(bidSub & ~1n))
    ) {
      carved.nbt.delete(nid)
    }
  }
  if (!carved.nbt.has(BigInt(NID_MESSAGE_STORE))) return null

  // Node entries: the message store must come first (the parser asserts the
  // first key it meets is 0x21); the rest sorted for tidy interior keys.
  const nids = [...carved.nbt.keys()].filter((n) => n !== BigInt(NID_MESSAGE_STORE)).sort((a, b) => (a < b ? -1 : 1))
  const nbtEntries = [
    carved.nbt.get(BigInt(NID_MESSAGE_STORE))!,
    ...nids.map((n) => carved.nbt.get(n)!),
  ]
  const bids = [...carved.bbt.keys()].sort((a, b) => (a < b ? -1 : 1))
  const bbtEntries = bids.map((b) => carved.bbt.get(b)!)

  const L = layout
  const baseIb = BigInt(Math.ceil(file.size / L.pageSize) + 1) * BigInt(L.pageSize)
  const pages: Uint8Array[] = []
  const nextBid = { v: 0x100000000000n }
  const nbtRoot = buildTree(L, nbtEntries, NBT_ENTRY, L.maxNbt, pages, baseIb, nextBid)
  const bbtBase = baseIb + BigInt(pages.length) * BigInt(L.pageSize)
  const bbtPages: Uint8Array[] = []
  const bbtRoot = bbtEntries.length
    ? buildTree(L, bbtEntries, BBT_ENTRY, L.maxBbt, bbtPages, bbtBase, nextBid)
    : null
  if (!bbtRoot) return null
  pages.push(...bbtPages)

  // Synthetic header: reuse the original bytes when present so incidental
  // fields survive, then overwrite everything the parser actually reads.
  const header = new Uint8Array(1024)
  if (file.size >= 1024) header.set(new Uint8Array(await file.slice(0, 1024).arrayBuffer()))
  const hv = new DataView(header.buffer)
  header.set([0x21, 0x42, 0x44, 0x4e], 0) // "!BDN"
  hv.setUint8(10, L.version)
  const usedEnc = encType ?? headerEnc ?? 1
  hv.setUint8(0x201, usedEnc)
  hv.setBigUint64(0xd8, nbtRoot.rootBid, true)
  hv.setBigUint64(0xe0, nbtRoot.rootIb, true)
  hv.setBigUint64(0xe8, bbtRoot.rootBid, true)
  hv.setBigUint64(0xf0, bbtRoot.rootIb, true)

  const overlayStart = Number(baseIb)
  const overlay = new Uint8Array(pages.length * L.pageSize)
  pages.forEach((p, i) => overlay.set(p, i * L.pageSize))

  // Reads outside the synthetic header/overlay hit the original file; go
  // through the caching reader so browsing a recovered mailbox is not one
  // file-thread round trip per block.
  const base = makeChunkedReader(file)
  const reader: ReadFileApi = {
    readFile: async (buffer, offset, length, position) => {
      const out = new Uint8Array(buffer, offset, length)
      let produced = 0
      for (let i = 0; i < length; ) {
        const pos = position + i
        if (pos < 1024) {
          const n = Math.min(length - i, 1024 - pos)
          out.set(header.subarray(pos, pos + n), i)
          produced = i + n
        } else if (pos >= overlayStart) {
          const rel = pos - overlayStart
          if (rel >= overlay.byteLength) break
          const n = Math.min(length - i, overlay.byteLength - rel)
          out.set(overlay.subarray(rel, rel + n), i)
          produced = i + n
        } else {
          const end = Math.min(position + length, file.size, overlayStart)
          if (pos >= end) break
          const got = await base.readFile(buffer, offset + i, end - pos, pos)
          if (got === 0) break
          produced = i + got
        }
        i = produced
      }
      return produced
    },
    close: () => base.close(),
  }

  return {
    reader,
    layout,
    nodes: carved.nbt.size,
    blocks: carved.bbt.size,
    usedEnc,
    encFromHeader: encType === null && headerEnc !== null,
  }
}

/** How much of the sampled text is printable (wrong decryption yields noise). */
function printableRatio(samples: string[]): number {
  const text = samples.join('')
  if (!text) return 0
  let ok = 0
  for (const ch of text) {
    const c = ch.codePointAt(0) ?? 0
    if (c === 9 || c === 10 || c === 13 || (c >= 32 && c !== 0xfffd)) ok++
  }
  return ok / [...text].length
}

async function probeQuality(pst: IPSTFile): Promise<number> {
  const samples: string[] = []
  try {
    const root = await pst.getRootFolder()
    const walk = async (folder: Awaited<ReturnType<IPSTFile['getRootFolder']>>, depth: number) => {
      samples.push(folder.displayName ?? '')
      if (depth >= 2 || samples.length > 30) return
      for (const sub of await folder.getSubFolders()) await walk(sub, depth + 1)
    }
    await walk(root, 0)
  } catch {
    return 0
  }
  return printableRatio(samples)
}

export interface SalvageOutcome {
  pst: IPSTFile
  nodes: number
}

/**
 * Try to open a damaged file via carving. When the original header survived,
 * its encryption flag is trusted; otherwise both settings are tried and the
 * one producing readable folder names wins.
 */
export async function salvageOpenPst(file: File): Promise<SalvageOutcome | null> {
  const first = await buildSalvage(file, null)
  if (!first) return null

  // When the header is gone the encryption flag is a guess; try the default
  // first and the alternative only if the result reads badly.
  const plans: (SalvagePlan | null)[] = [first]
  if (!first.encFromHeader) plans.push(await buildSalvage(file, first.usedEnc === 1 ? 0 : 1))

  let best: { pst: IPSTFile; score: number } | null = null
  for (const plan of plans) {
    if (!plan) continue
    try {
      const pst = await openPst(plan.reader)
      const score = await probeQuality(pst)
      if (!best || score > best.score) {
        if (best) await best.pst.close().catch(() => {})
        best = { pst, score }
      } else {
        await pst.close().catch(() => {})
      }
      if (best.score > 0.95) break
    } catch {
      // try the other encryption guess
    }
  }
  if (!best || best.score < 0.5) {
    if (best) await best.pst.close().catch(() => {})
    return null
  }
  return { pst: best.pst, nodes: first.nodes }
}
