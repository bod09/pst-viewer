import { beforeAll, expect, test } from 'vitest'
import type { PstWorkerApi } from '../../src/worker/pst.worker'
import type { FolderNode, MessageContent, MessageMeta } from '../../src/types'
import { sha } from '../../scripts/lib/fidelity.mjs'
import { publicMailbox } from '../support/mailboxes'
import { loadWorker } from '../support/worker'

/**
 * An old (ANSI, Outlook 97-2002) .pst keeps its text as 8-bit strings in the
 * code page of the machine that wrote it, and says nowhere in its header
 * which. contacts97-2002.pst is contacts.pst, a Unicode file whose one
 * contact has a Japanese name, saved in that old format: read as
 * windows-1252, as every ANSI file used to be, its folder names and its
 * contact came out as nonsense. Read in the code page its messages name, it
 * says exactly what the Unicode file says, and that is what is checked here:
 * one file against the other, so nothing from inside either is written down.
 */
const all = (node: FolderNode): FolderNode[] => [node, ...node.children.flatMap(all)]

interface Reading {
  /** The folder the contact is in, and every folder above it, top down. */
  path: string[]
  row: MessageMeta
  content: MessageContent
}

let api: PstWorkerApi
const readings = new Map<string, Reading>()

async function read(name: string): Promise<Reading> {
  const index = await api.openSource(name, publicMailbox(name))
  const parents = new Map<string, FolderNode>()
  for (const f of all(index.rootFolder)) for (const c of f.children) parents.set(c.id, f)
  for (const folder of all(index.rootFolder)) {
    for (const row of (await api.getFolderMessages(name, folder.id)).messages) {
      const content = await api.getMessageContent(name, row.id)
      if (content?.itemKind !== 'contact') continue
      const path: string[] = []
      for (let f: FolderNode | undefined = folder; f; f = parents.get(f.id)) path.unshift(f.name)
      return { path, row, content }
    }
  }
  throw new Error(`${name} holds no contact`)
}

beforeAll(async () => {
  api = await loadWorker()
  for (const name of ['contacts.pst', 'contacts97-2002.pst']) readings.set(name, await read(name))
})

const unicode = () => readings.get('contacts.pst')!
const ansi = () => readings.get('contacts97-2002.pst')!

test('the folders the contact is kept in have the same names', () => {
  expect(ansi().path.length).toBeGreaterThan(1)
  expect(ansi().path.map(sha)).toEqual(unicode().path.map(sha))
})

test('the list shows the same subject and sender', () => {
  expect(sha(ansi().row.subject)).toBe(sha(unicode().row.subject))
  expect(sha(ansi().row.fromName)).toBe(sha(unicode().row.fromName))
  expect(sha(ansi().row.fromEmail)).toBe(sha(unicode().row.fromEmail))
})

test('the contact card reads the same', () => {
  const card = (r: Reading) => sha(JSON.stringify(r.content.contact))
  expect(ansi().content.contact?.fullName).toBeTruthy()
  expect(card(ansi())).toBe(card(unicode()))
  expect(sha(ansi().content.subject)).toBe(sha(unicode().content.subject))
})

test('the name is in its own script, not in Latin letters', () => {
  // A Japanese name read in the wrong code page still looks like a name: it
  // is made of Latin-1 letters and symbols. Read right, it is not.
  const name = ansi().content.contact!.fullName
  expect([...name].some((ch) => ch.codePointAt(0)! > 0x2000)).toBe(true)
})

test('the contact is found by a word of its name', async () => {
  await api.setSourceLabel('contacts97-2002.pst', 'contacts97-2002.pst')
  await api.indexSource('contacts97-2002.pst')
  const word = ansi().content.subject.split(/[^\p{L}]+/u).find((w) => w.length >= 3)
  expect(word).toBeTruthy()
  const hits = await api.search(`mailbox:"contacts97-2002.pst" ${word}`)
  expect(hits.map((h) => h.messageId)).toEqual([ansi().row.id])
})
