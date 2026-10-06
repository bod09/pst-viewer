import PostalMime from 'postal-mime'
import { beforeAll, describe, expect, test, vi } from 'vitest'
import type { PstWorkerApi } from '../../src/worker/pst.worker'
import type { EmlExportStep, FolderNode } from '../../src/types'
import { createFreshDirectory, MboxFolder, MboxTreeWriter } from '../../src/lib/bulkExport'
import { sha } from '../../scripts/lib/fidelity.mjs'
import { fileOf, fixture } from '../support/files'
import { publicMailbox, publicMailboxNames } from '../support/mailboxes'
import { readMboxrd } from '../support/mboxrd'
import { MemoryFs, type MemoryDirectory } from '../support/memory-fs'
import { loadWorker } from '../support/worker'

/**
 * The worker's export written as .mbox files, end to end: what the worker
 * sends for each message goes through MboxTreeWriter into an in-memory
 * folder, and is read back with the tests' own mboxrd reader. Each message
 * read back must be the very message the .eml export gives, byte for byte,
 * apart from its line endings (LF in an mbox file).
 *
 * MIME boundaries are random, and an attached message carries its own inside
 * its base64, so the random numbers are made to repeat: each folder's export
 * starts from the same sequence.
 */
let api: PstWorkerApi

let draws = 0
const sameRandomNumbers = () => {
  draws = 0
}

const all = (node: FolderNode): FolderNode[] => [node, ...node.children.flatMap(all)]

/** A message as an mbox file keeps it: LF line endings. */
const stable = (text: string) => text.replace(/\r\n/g, '\n')

/** Each message of an .eml export of one folder, as text. */
async function emlOf(sourceId: string, folderId: string): Promise<string[]> {
  const out: string[] = []
  let pieces: Uint8Array[] = []
  sameRandomNumbers()
  await api.exportFolderEml(sourceId, folderId, async (step: EmlExportStep) => {
    if (step.kind === 'start') pieces = []
    else if (step.kind === 'data') pieces.push(step.data)
    else if (step.kind === 'end') out.push(new TextDecoder().decode(Buffer.concat(pieces)))
    return true
  })
  return out
}

/** An MBOX export of `folders` (and only those, each a top-level file), into memory. */
async function mboxOf(
  sourceId: string,
  folders: FolderNode[],
  options: { cancelAfter?: number; failPartWayThrough?: number } = {},
) {
  // Which message is being written, so a write can be made to fail part-way
  // through one: its second write, after the separator line.
  let message = 0
  let writes = 0
  const fs = new MemoryFs({
    fail: (op) =>
      op === 'write' && message === options.failPartWayThrough && ++writes === 2
        ? new DOMException('Disk hiccup.', 'InvalidStateError')
        : null,
  })
  const dir = await createFreshDirectory(fs.handle, sourceId, 'Mailbox')
  const root = MboxFolder.root(dir, sourceId)
  let cancelled = false
  const writer = new MboxTreeWriter(() => cancelled)
  const places = new Map<string, MboxFolder>()
  const fileNames = new Map<string, string>()
  for (const f of folders) {
    const place = root.child(f.id)
    places.set(f.id, place)
    fileNames.set(f.id, place.name())
  }
  let ends = 0
  let notListed = 0
  for (const f of folders) {
    sameRandomNumbers()
    const result = await api.exportFolderEml(sourceId, f.id, async (step) => {
      if (step.kind === 'start') [message, writes] = [message + 1, 0]
      const go = await writer.step(step, (id) => places.get(id)!)
      if (step.kind === 'end' && ++ends === options.cancelAfter) cancelled = true
      return go
    })
    notListed += result.notListed
  }
  await writer.discard()
  const out: MemoryDirectory = fs.root.dir(dir.nameOnDisk)
  const read = (folderId: string) => {
    const name = fileNames.get(folderId)!
    return out.list().includes(name) ? readMboxrd(out.file(name).text) : []
  }
  return { writer, read, out, notListed }
}

beforeAll(async () => {
  vi.spyOn(Math, 'random').mockImplementation(() => (++draws * 0.6180339887498949) % 1)
  api = await loadWorker()
  await api.openMsgSource('loose', [
    fixture('mail.eml'),
    fixture('spoof-sender.eml'),
    fixture('forwarded.eml'),
    fixture('hostile-html.eml'),
    fixture('mail.msg'),
    fileOf('not-mail.eml', 'this is not a message'),
  ])
  await api.indexSource('loose')
})

const looseFolder = { id: 'msgfolder' } as FolderNode

describe('exporting made-up mail as .mbox', () => {
  test('each message read back is the message the .eml export gives', async () => {
    const eml = await emlOf('loose', 'msgfolder')
    const { read, writer, notListed } = await mboxOf('loose', [looseFolder])
    const back = read('msgfolder')
    expect(back).toHaveLength(5)
    // The file that is not mail is left out, and counted.
    expect(notListed).toBe(1)
    expect(back.map((m) => stable(m.message))).toEqual(eml.map(stable))
    expect([writer.exported, writer.unreadable, writer.unsaved]).toEqual([5, 0, 0])
  })

  test('and parses to the same subject, sender, body and attachments', async () => {
    const eml = await emlOf('loose', 'msgfolder')
    const back = (await mboxOf('loose', [looseFolder])).read('msgfolder')
    for (const [i, m] of back.entries()) {
      const a = await PostalMime.parse(m.message, { attachmentEncoding: 'arraybuffer' })
      const b = await PostalMime.parse(eml[i], { attachmentEncoding: 'arraybuffer' })
      expect([a.subject, a.from, a.text, a.html]).toEqual([b.subject, b.from, b.text, b.html])
      const files = (e: typeof a) => e.attachments.map((x) => [x.filename, x.mimeType, sha(Buffer.from(x.content as ArrayBuffer))])
      expect(files(a)).toEqual(files(b))
    }
  })

  test('a message read back opens in the viewer as the same message', async () => {
    const back = (await mboxOf('loose', [looseFolder])).read('msgfolder')
    await api.openMsgSource(
      'from-mbox',
      back.map((m, i) => fileOf(`${i}.eml`, m.message)),
    )
    const before = (await api.getFolderMessages('loose', 'msgfolder')).messages
    const after = (await api.getFolderMessages('from-mbox', 'msgfolder')).messages
    const shown = (m: (typeof before)[number]) => [m.subject, m.fromName, m.fromEmail, m.to, m.date, m.hasAttachments]
    expect(after.map(shown)).toEqual(before.map(shown))
    await api.closeSource('from-mbox')
  })

  test('each separator carries the message\'s date, or the time of the export for one without', async () => {
    const before = Date.now()
    const back = (await mboxOf('loose', [looseFolder])).read('msgfolder')
    expect(back[0].separator).toBe('From MAILER-DAEMON Tue Mar 12 10:15:00 2024')
    // The .msg has no date.
    const year = new Date(before).getUTCFullYear()
    expect(back[4].separator).toMatch(new RegExp(`^From MAILER-DAEMON \\w{3} \\w{3} [ \\d]\\d \\d\\d:\\d\\d:\\d\\d ${year}$`))
  })

  test('cancelled part-way, the file holds just the messages finished before', async () => {
    const eml = await emlOf('loose', 'msgfolder')
    const { read, writer } = await mboxOf('loose', [looseFolder], { cancelAfter: 2 })
    expect(read('msgfolder').map((m) => stable(m.message))).toEqual(eml.slice(0, 2).map(stable))
    expect(writer.exported).toBe(2)
  })

  test('a message whose writing fails part-way is cut out, and the rest are kept whole', async () => {
    const eml = await emlOf('loose', 'msgfolder')
    const { read, writer } = await mboxOf('loose', [looseFolder], { failPartWayThrough: 3 })
    const back = read('msgfolder').map((m) => stable(m.message))
    expect(back).toEqual([eml[0], eml[1], eml[3], eml[4]].map(stable))
    expect([writer.exported, writer.unsaved]).toEqual([4, 1])
  })
})

// The public test files: a real mailbox written out and read back. Nothing
// from inside them is written here; messages are compared with the .eml
// export of the same folder, and named by hash when they differ.
describe('exporting every public mailbox as .mbox', () => {
  test.each(publicMailboxNames)('%s: each folder\'s file holds its messages, the same as the .eml export', async (name) => {
    const index = await api.openSource(`mbox:${name}`, publicMailbox(name))
    const source = `mbox:${name}`
    const folders = all(index.rootFolder)
    const { read, writer, notListed } = await mboxOf(source, folders)
    expect(notListed).toBe(0)
    expect(writer.unsaved).toBe(0)
    expect(writer.fatal).toBeNull()
    let total = 0
    for (const f of folders) {
      const eml = await emlOf(source, f.id)
      const back = read(f.id)
      // Every message the folder lists (none of these files has unreadable ones).
      expect(back.length, sha(f.name)).toBe(f.messageCount)
      expect(back.length, sha(f.name)).toBe(eml.length)
      for (const [i, m] of back.entries()) {
        expect(sha(stable(m.message)), `${sha(f.name)} message ${i}`).toBe(sha(stable(eml[i])))
      }
      total += back.length
    }
    expect(writer.unreadable).toBe(0)
    expect(total).toBe(index.totalMessages)
    await api.closeSource(source)
  })
})
