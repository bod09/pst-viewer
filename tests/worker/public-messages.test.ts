import PostalMime from 'postal-mime'
import { beforeAll, describe, expect, test } from 'vitest'
import type { PstWorkerApi } from '../../src/worker/pst.worker'
import type { EmlExportStep, MessageContent, SourceIndex } from '../../src/types'
import { publicMailbox, publicMessageNames, usable } from '../support/mailboxes'
import { loadWorker } from '../support/worker'

/**
 * Real .msg files saved from Outlook (the msgreader project's test data),
 * opened together as dropping them on the app would. As with the public
 * mailboxes, nothing from inside the files is written here.
 */
let api: PstWorkerApi
let index: SourceIndex
/** Content of each file, by its file name. */
const byFile = new Map<string, { id: string; content: MessageContent }>()

beforeAll(async () => {
  api = await loadWorker()
  index = await api.openMsgSource('msgs', publicMessageNames.map(publicMailbox))
  await api.indexSource('msgs')
  for (const folder of index.rootFolder.children) {
    for (const m of (await api.getFolderMessages('msgs', folder.id)).messages) {
      // Message ids are "msg" and the file's position in the batch.
      const name = publicMessageNames[Number(m.id.slice(3))]
      byFile.set(name, { id: m.id, content: (await api.getMessageContent('msgs', m.id))! })
    }
  }
})

describe('real .msg files', () => {
  test('every one opens, and each lands in the folder for its kind', () => {
    expect(byFile.size).toBe(publicMessageNames.length)
    expect(index.totalMessages).toBe(publicMessageNames.length)
    const count = (name: string) => index.rootFolder.children.find((f) => f.name === name)?.messageCount
    const kinds = [...byFile.values()].map((f) => f.content.itemKind)
    expect(count('Messages')).toBe(kinds.filter((k) => k === 'email').length)
    expect(count('Contacts')).toBe(kinds.filter((k) => k === 'contact').length)
    expect(count('Calendar')).toBe(kinds.filter((k) => k === 'appointment').length)
    expect(count('Contacts')).toBe(2)
    expect(count('Calendar')).toBeGreaterThan(0)
  })

  test.each(publicMessageNames)('%s: has something to read', (name) => {
    const { content } = byFile.get(name)!
    expect(content.subject.length).toBeGreaterThan(0)
    expect(`${content.html ?? ''}${content.text ?? ''}`.length).toBeGreaterThan(0)
    // Text that was decoded with the wrong code page shows as replacement characters.
    expect(`${content.subject}${content.text ?? ''}${content.fromName}`).not.toContain('�')
  })

  test.each(['contactUnicode.msg', 'contactAnsi.msg'])('%s: is a contact, with a card', (name) => {
    const { content } = byFile.get(name)!
    expect(content.itemKind).toBe('contact')
    expect(content.contact?.fullName).toBeTruthy()
    expect(content.contact?.emails).toHaveLength(1)
    expect(content.contact?.emails[0].address).toContain('@')
    expect(content.contact?.phones.length).toBeGreaterThan(0)
  })

  test('a contact stored in 8-bit text reads the same as its Unicode twin', () => {
    // The two files are the same contact saved both ways.
    const card = (name: string) => byFile.get(name)!.content.contact!
    expect(card('contactAnsi.msg').emails).toEqual(card('contactUnicode.msg').emails)
    expect(card('contactAnsi.msg').phones).toEqual(card('contactUnicode.msg').phones)
  })

  // "A schedule.msg" names its author, so it is not kept in samples/ and is here only once downloaded.
  test.each(['A schedule.msg', 'A weekly 1.msg'].filter(usable))('%s: is an appointment, with a start and an end', (name) => {
    const { content } = byFile.get(name)!
    expect(content.itemKind).toBe('appointment')
    expect(content.appointment?.start).toBeGreaterThan(Date.UTC(2020, 0, 1))
    expect(content.appointment!.end!).toBeGreaterThan(content.appointment!.start!)
    expect(content.appointment?.organizer).toBeTruthy()
  })

  test('text in a Japanese code page is read as Japanese', () => {
    const { content } = byFile.get('nonUnicodeCP932.msg')!
    expect(`${content.subject}${content.text}`).toMatch(/[぀-ヿ一-鿿]/)
  })

  test('a picture shown in the body and a file attached beside it are told apart', async () => {
    const { id, content } = byFile.get('attachAndInline.msg')!
    expect(content.inlineImages).toHaveLength(1)
    expect(content.html).toContain(`cid:${content.inlineImages[0].cid}`)
    const files = content.attachments.filter((a) => !a.isInline)
    expect(files).toHaveLength(1)
    const data = await api.getAttachmentData('msgs', id, files[0].index)
    expect(data?.data.byteLength).toBe(files[0].size)
  })

  test('several attached files each come back whole', async () => {
    const { id, content } = byFile.get('attachmentFiles.msg')!
    expect(content.attachments.map((a) => a.mime)).toEqual(['image/jpeg', 'image/png', 'image/tiff'])
    for (const a of content.attachments) {
      const data = await api.getAttachmentData('msgs', id, a.index)
      expect(data?.data.byteLength, a.name).toBe(a.size)
    }
    // Each really is the kind of file it claims to be.
    const magic = async (i: number) => [...new Uint8Array((await api.getAttachmentData('msgs', id, i))!.data).subarray(0, 3)]
    expect(await magic(0)).toEqual([0xff, 0xd8, 0xff])
    expect(await magic(1)).toEqual([0x89, 0x50, 0x4e])
  })

  test('a message inside a message inside a message opens all the way down', async () => {
    const { id, content } = byFile.get('msgInMsgInMsg.msg')!
    const first = content.attachments.find((a) => a.isEmbeddedMessage)!
    const inner = await api.getEmbeddedMessageContent('msgs', id, first.index)
    expect(inner?.content.subject).toBeTruthy()
    const second = inner!.content.attachments.find((a) => a.isEmbeddedMessage)!
    const innermost = await api.getEmbeddedMessageContent('msgs', inner!.id, second.index)
    expect(innermost?.content.subject).toBeTruthy()
    expect(`${innermost!.content.html ?? ''}${innermost!.content.text ?? ''}`.length).toBeGreaterThan(0)
  })

  test('every one is listed by search and exports as an .eml that reads back', async () => {
    // With no words to look for, a filter that everything passes lists the lot.
    expect(await api.search('after:1990-01-01 before:2100-01-01')).toHaveLength(
      [...byFile.values()].filter((f) => f.content.date !== null).length,
    )
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
    for (const folder of index.rootFolder.children) await api.exportFolderEml('msgs', folder.id, sink)
    expect(skipped).toBe(0)
    expect(exported).toHaveLength(publicMessageNames.length)
    const subjects = [...byFile.values()].map((f) => f.content.subject).sort()
    expect(exported.map((e) => e.subject).sort()).toEqual(subjects)
    for (const e of exported) {
      const email = await PostalMime.parse(e.bytes, { attachmentEncoding: 'arraybuffer', rfc822Attachments: true })
      expect(email.subject ?? '', e.subject).toBe(e.subject)
    }
  })
})
