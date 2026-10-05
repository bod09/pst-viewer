import PostalMime from 'postal-mime'
import { beforeAll, describe, expect, test } from 'vitest'
import type { PstWorkerApi } from '../../src/worker/pst.worker'
import type { EmlExportStep, FolderNode, MessageMeta, SourceIndex } from '../../src/types'
import { sha } from '../../scripts/lib/fidelity.mjs'
import { publicMailbox, publicMailboxNames } from '../support/mailboxes'
import { loadWorker } from '../support/worker'

/**
 * Real .pst and .ost files, read end to end.
 *
 * The fidelity baselines (fidelity.test.ts) already pin down exactly what is
 * read from these files. The tests here are about behaviour on real data that
 * a baseline cannot express: that everything listed can be opened, found by
 * search and exported. Nothing from inside the mailboxes is written into this
 * file; the tests compare what the worker says in one place with what it says
 * in another. Text is compared as hashes, so a failure names the message
 * without printing its subject or its people into a test log.
 */
const all = (node: FolderNode): FolderNode[] => [node, ...node.children.flatMap(all)]

let api: PstWorkerApi

interface Opened {
  index: SourceIndex
  /** Every message in the mailbox, with the folder row it is listed under. */
  messages: MessageMeta[]
  unreadable: number
}
const opened = new Map<string, Opened>()

beforeAll(async () => {
  api = await loadWorker()
  for (const name of publicMailboxNames) {
    const index = await api.openSource(name, publicMailbox(name))
    await api.setSourceLabel(name, name)
    await api.indexSource(name)
    const messages: MessageMeta[] = []
    let unreadable = 0
    for (const folder of all(index.rootFolder)) {
      const list = await api.getFolderMessages(name, folder.id)
      messages.push(...list.messages)
      unreadable += list.unreadable
    }
    opened.set(name, { index, messages, unreadable })
  }
}, 60_000)

// The small synthetic mailboxes in samples/ are always here; the larger ones
// with real mail in them only once downloaded (`npm run mailboxes`).
describe('every public mailbox', () => {
  test.each(publicMailboxNames)('%s: the counts shown add up', (name) => {
    const { index, messages, unreadable } = opened.get(name)!
    const rows = all(index.rootFolder).slice(1)
    expect(index.totalMessages).toBeGreaterThan(0)
    // The total on the mailbox is the sum of its rows, and each is what its folder lists.
    expect(rows.reduce((n, f) => n + f.messageCount, 0)).toBe(index.totalMessages)
    expect(messages.length + unreadable).toBe(index.totalMessages)
    expect(unreadable).toBe(0)
    expect(new Set(all(index.rootFolder).map((f) => f.id)).size).toBe(all(index.rootFolder).length)
    expect(new Set(messages.map((m) => m.id)).size).toBe(messages.length)
  })

  test.each(publicMailboxNames)('%s: every listed message opens, and says what the list said', async (name) => {
    const { messages } = opened.get(name)!
    for (const m of messages) {
      const content = await api.getMessageContent(name, m.id)
      expect(content, m.id).not.toBeNull()
      expect(sha(content!.subject), `${m.id} subject`).toBe(sha(m.subject))
      expect(content!.date, `${m.id} date`).toBe(m.date)
      expect(sha(content!.fromEmail), `${m.id} sender`).toBe(sha(m.fromEmail))
      // A message is something to read: an email has a body (other items have a card).
      const hasBody = typeof (content!.html ?? content!.text) === 'string'
      expect(hasBody || content!.itemKind !== 'email', `${m.id} body`).toBe(true)
      // The paperclip in the list means there is something to open.
      expect(content!.attachments.length > 0 || !m.hasAttachments, `${m.id} paperclip`).toBe(true)
      const files = content!.attachments.filter((a) => !a.isInline || a.isEmbeddedMessage)
      for (const a of files) {
        const opens = a.isEmbeddedMessage
          ? Boolean((await api.getEmbeddedMessageContent(name, m.id, a.index))?.content)
          : ((await api.getAttachmentData(name, m.id, a.index))?.data.byteLength ?? 0) > 0
        expect(opens, `${m.id} attachment ${a.index}`).toBe(true)
      }
    }
  })

  test.each(publicMailboxNames)('%s: every message can be found by its own subject', async (name) => {
    const { messages } = opened.get(name)!
    // A word of at least five letters from each subject. (A message with no
    // subject is listed under a placeholder in brackets, which is not its text.)
    const searchable = messages
      .filter((m) => !m.subject.startsWith('('))
      .map((m) => ({ id: m.id, word: m.subject.split(/[^\p{L}]+/u).find((w) => w.length >= 5) }))
      .filter((m): m is { id: string; word: string } => Boolean(m.word))
    // Most messages have one; if hardly any did, the loop below would prove little.
    expect(searchable.length).toBeGreaterThan(messages.length / 2)
    for (const m of searchable) {
      const hits = await api.search(`mailbox:"${name}" ${m.word}`)
      expect(hits.some((h) => h.messageId === m.id), `${m.id} by a word of its subject`).toBe(true)
    }
    const everything = await api.search(`mailbox:"${name}"`)
    expect(everything.map((h) => h.messageId).sort()).toEqual(messages.map((m) => m.id).sort())
  })

  test.each(publicMailboxNames)('%s: every message exports as an .eml that reads back', async (name) => {
    const { index, messages } = opened.get(name)!
    const exported: { subject: string; bytes: Uint8Array }[] = []
    let pieces: Uint8Array[] = []
    let subject = ''
    let skipped = 0
    const sink = async (step: EmlExportStep) => {
      if (step.kind === 'start') [subject, pieces] = [step.subject, []]
      else if (step.kind === 'data') pieces.push(step.data)
      else if (step.kind === 'end') exported.push({ subject, bytes: new Uint8Array(Buffer.concat(pieces)) })
      else skipped++
      return true
    }
    let notListed = 0
    for (const folder of all(index.rootFolder)) {
      notListed += (await api.exportFolderEml(name, folder.id, sink)).notListed
    }
    expect(skipped).toBe(0)
    expect(notListed).toBe(0)
    expect(exported.map((e) => sha(e.subject))).toEqual(messages.map((m) => sha(m.subject)))

    for (const [i, e] of exported.entries()) {
      const text = new TextDecoder().decode(e.bytes)
      // Well formed: CRLF only, no over-long lines, every boundary closed.
      expect(text.replace(/\r\n/g, ''), `${messages[i].id} line endings`).not.toMatch(/[\r\n]/)
      for (const [, boundary] of text.matchAll(/boundary="(=_pstv_[^"]+)"/g)) {
        expect(text, `${messages[i].id} boundary`).toContain(`--${boundary}--`)
      }
      const email = await PostalMime.parse(e.bytes, { attachmentEncoding: 'arraybuffer', rfc822Attachments: true })
      const content = await api.getMessageContent(name, messages[i].id)
      const expected = content!.attachments.filter((a) => a.isEmbeddedMessage || !(a.isInline && a.cid))
      expect(email.attachments.filter((a) => a.disposition === 'attachment').length, messages[i].id).toBe(
        expected.length,
      )
    }
  })
})

describe('mail kept directly in the top folder of a .pst', () => {
  // alpha-beta-gamma-delta.pst keeps its one message in "Top of Outlook data
  // file" itself, which the sidebar used to have no row for.
  const name = 'alpha-beta-gamma-delta.pst'

  test('has a row of its own, is counted, and opens', async () => {
    const { index, messages } = opened.get(name)!
    expect(index.totalMessages).toBe(1)
    const [row] = index.rootFolder.children
    expect(row.messageCount).toBe(1)
    expect(row.children).toEqual([])
    expect(messages).toHaveLength(1)
    expect(messages[0].folderId).toBe(row.id)
    const content = await api.getMessageContent(name, messages[0].id)
    expect(content?.attachments).toHaveLength(2)
    expect(content?.attachments.filter((a) => a.isEmbeddedMessage)).toHaveLength(1)
  })

  test('is found by search, under the folder name the sidebar shows', async () => {
    const { index, messages } = opened.get(name)!
    const row = index.rootFolder.children[0]
    const hits = await api.search(`mailbox:"${name}" folder:"${row.name}"`)
    expect(hits.map((h) => h.messageId)).toEqual([messages[0].id])
  })
})

describe('items that are not email', () => {
  test.each(['contacts.pst', 'contacts97-2002.pst'])('%s: a contact opens as a contact card', async (name) => {
    const { messages } = opened.get(name)!
    const contents = await Promise.all(messages.map((m) => api.getMessageContent(name, m.id)))
    const contact = contents.find((c) => c?.itemKind === 'contact')
    expect(contact?.contact?.fullName).toBeTruthy()
    expect(contact?.contact?.emails.length).toBeGreaterThan(0)
  })
})
