import { beforeAll, describe, expect, test } from 'vitest'
import type { PstWorkerApi } from '../../src/worker/pst.worker'
import type { FolderNode, SourceIndex } from '../../src/types'
import { fileOf } from '../support/files'
import { havePublicMailboxes, publicMailbox } from '../support/mailboxes'
import { loadWorker } from '../support/worker'

/**
 * Damaged mailboxes: real ones, damaged here on purpose.
 *
 * When a file's header or index is broken the worker rebuilds them from what
 * survives (src/worker/salvage.ts) and marks the mailbox as recovered. These
 * tests break a healthy file in a known way and compare what is recovered
 * with what the healthy file holds.
 */
const all = (node: FolderNode): FolderNode[] => [node, ...node.children.flatMap(all)]

let api: PstWorkerApi

/** Subjects of every message that can be listed, sorted. */
async function listed(sourceId: string, index: SourceIndex): Promise<string[]> {
  const subjects: string[] = []
  for (const folder of all(index.rootFolder)) {
    for (const m of (await api.getFolderMessages(sourceId, folder.id)).messages) subjects.push(m.subject)
  }
  return subjects.sort()
}

/** Open a copy of a public mailbox after `damage` has been done to its bytes. */
async function openDamaged(name: string, damage: (bytes: Uint8Array) => void) {
  const bytes = new Uint8Array(await publicMailbox(name).arrayBuffer())
  damage(bytes)
  const index = await api.openSource('damaged', fileOf(name, bytes))
  return { index, subjects: await listed('damaged', index) }
}

async function healthy(name: string) {
  const index = await api.openSource('healthy', publicMailbox(name))
  const subjects = await listed('healthy', index)
  await api.closeSource('healthy')
  return { index, subjects }
}

beforeAll(async () => {
  api = await loadWorker()
})

describe.skipIf(!havePublicMailboxes)('a mailbox whose header is destroyed', () => {
  test.each([
    ['a .pst', 'enron.pst'],
    ['an .ost', 'pstextractortest@outlook.com.ost'],
  ])('%s is rebuilt from its surviving pages, with every message back', async (_what, name) => {
    const before = await healthy(name)
    expect(before.index.recovered).toBeFalsy()

    const after = await openDamaged(name, (bytes) => bytes.fill(0, 0, 512))
    expect(after.index.recovered).toBe(true)
    expect(after.index.totalMessages).toBe(before.index.totalMessages)
    expect(after.subjects).toEqual(before.subjects)
    await api.closeSource('damaged')
  })

  test('the same when only its pointers to the index are wrong', async () => {
    const before = await healthy('enron.pst')
    const after = await openDamaged('enron.pst', (bytes) => bytes.fill(0xff, 0xb4, 0x100))
    expect(after.index.recovered).toBe(true)
    expect(after.subjects).toEqual(before.subjects)
    await api.closeSource('damaged')
  })
})

describe.skipIf(!havePublicMailboxes)('a mailbox with part of it missing', () => {
  test('shows what survives, and every message it lists can be opened', async () => {
    const before = await healthy('enron.pst')
    // The last fifth of the file is gone, as after an interrupted copy.
    const after = await openDamaged('enron.pst', (bytes) => bytes.fill(0, Math.floor(bytes.length * 0.8)))
    expect(after.index.recovered).toBe(true)
    expect(after.subjects.length).toBeGreaterThan(before.subjects.length / 2)
    expect(after.subjects.length).toBeLessThan(before.subjects.length)
    // Nothing is invented: what is listed was in the healthy file.
    const known = new Set(before.subjects)
    expect(after.subjects.filter((s) => !known.has(s))).toEqual([])

    let opened = 0
    for (const folder of all(after.index.rootFolder)) {
      for (const m of (await api.getFolderMessages('damaged', folder.id)).messages) {
        expect(await api.getMessageContent('damaged', m.id), m.id).not.toBeNull()
        opened++
      }
    }
    expect(opened).toBe(after.subjects.length)
    await api.closeSource('damaged')
  })
})

describe.skipIf(!havePublicMailboxes)('a file that cannot be recovered', () => {
  test('an old-format .pst with no header is refused with the reason, not opened empty', async () => {
    // Recovery covers the current formats; the 1997-2002 one is read only when intact.
    const bytes = new Uint8Array(await publicMailbox('contacts97-2002.pst').arrayBuffer())
    bytes.fill(0, 0, 512)
    await expect(api.openSource('damaged', fileOf('old.pst', bytes))).rejects.toThrow('Invalid file header')
  })
})

describe('a file that is not a mailbox at all', () => {
  test.each([
    ['empty', new Uint8Array(0)],
    ['a few bytes', new Uint8Array([1, 2, 3, 4])],
    ['text', new TextEncoder().encode('this is not a pst file. '.repeat(500))],
    ['zeroes', new Uint8Array(64 * 1024)],
    ['the right first bytes and nothing else', Uint8Array.from({ length: 2000 }, (_, i) => [0x21, 0x42, 0x44, 0x4e][i] ?? 0)],
  ])('%s: is refused', async (_what, bytes) => {
    await expect(api.openSource('junk', fileOf('junk.pst', bytes))).rejects.toThrow(/./)
    // And it leaves nothing half-open behind.
    expect(await api.getFolderMessages('junk', 'anything')).toEqual({ messages: [], unreadable: 0 })
  })
})
