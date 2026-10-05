import { beforeAll, describe, expect, test } from 'vitest'
import type { PstWorkerApi } from '../../src/worker/pst.worker'
import type { MessageContent, SourceIndex } from '../../src/types'
import { PNG } from '../support/fixtures.mjs'
import { fileOf, fixture } from '../support/files'
import { loadWorker } from '../support/worker'

let api: PstWorkerApi
let index: SourceIndex
const contents = new Map<string, MessageContent>()

/** The opened message with this subject. */
const bySubject = (subject: string) => {
  const found = [...contents.entries()].find(([, c]) => c.subject === subject)
  if (!found) throw new Error(`no message with subject ${subject}`)
  return { id: found[0], content: found[1] }
}

beforeAll(async () => {
  api = await loadWorker()
  index = await api.openMsgSource('loose', [
    fixture('mail.eml'),
    fixture('spoof-sender.eml'),
    fixture('forwarded.eml'),
    fixture('hostile-html.eml'),
    fixture('mail.msg'),
    fileOf('not-mail.eml', 'this is not a message'),
    fileOf('not-mail.msg', new Uint8Array([1, 2, 3, 4])),
  ])
  await api.indexSource('loose')
  for (const m of (await api.getFolderMessages('loose', 'msgfolder')).messages) {
    const content = await api.getMessageContent('loose', m.id)
    if (content) contents.set(m.id, content)
  }
})

describe('opening loose message files', () => {
  test('they appear as one folder, and files that are not mail are counted, not shown', async () => {
    expect(index.totalMessages).toBe(5)
    expect(index.rootFolder.children.map((f) => [f.name, f.messageCount])).toEqual([['Messages', 5]])
    const list = await api.getFolderMessages('loose', 'msgfolder')
    expect(list.unreadable).toBe(2)
    expect(list.messages.map((m) => m.subject)).toEqual([
      'Quarterly zebra report',
      'Spoofed sender test',
      'Fwd: Original walrus memo',
      'Hostile markup test',
      'Distinctive msg subject wombat',
    ])
  })

  test('the list shows who, when and whether there are attachments', async () => {
    const { messages } = await api.getFolderMessages('loose', 'msgfolder')
    expect(messages[0]).toEqual({
      id: 'msg0',
      folderId: 'msgfolder',
      subject: 'Quarterly zebra report',
      fromName: 'Alice Example',
      fromEmail: 'alice@example.com',
      to: 'Bob Tester',
      date: Date.UTC(2024, 2, 12, 10, 15),
      hasAttachments: true,
      isRead: true,
      messageClass: 'IPM.Note',
    })
    // A picture shown inside the body is not an attachment in the list.
    expect(messages.find((m) => m.subject === 'Hostile markup test')?.hasAttachments).toBe(false)
  })

  test('a folder or mailbox that does not exist is empty, not an error', async () => {
    expect(await api.getFolderMessages('loose', 'no-such-folder')).toEqual({ messages: [], unreadable: 0 })
    expect(await api.getFolderMessages('no-such-mailbox', 'msgfolder')).toEqual({ messages: [], unreadable: 0 })
    expect(await api.getMessageContent('loose', 'no-such-message')).toBeNull()
    expect(await api.getMessageContent('no-such-mailbox', 'msg0')).toBeNull()
    expect(await api.getAttachmentData('loose', 'msg0', 99)).toBeNull()
  })
})

describe('an .eml message', () => {
  test('has its fields, body and original headers', () => {
    const { content } = bySubject('Quarterly zebra report')
    expect(content).toMatchObject({
      itemKind: 'email',
      fromName: 'Alice Example',
      fromEmail: 'alice@example.com',
      to: [{ name: 'Bob Tester', email: 'bob@example.com' }],
      cc: [],
      date: Date.UTC(2024, 2, 12, 10, 15),
      html: null,
      importance: null,
    })
    expect(content.text).toContain('Distinctive keyword: pomegranate.')
    expect(content.headers.split('\r\n')[0]).toBe('From: Alice Example <alice@example.com>')
    expect(content.headers).toContain('Subject: Quarterly zebra report')
  })

  test('its attachment comes back byte for byte', async () => {
    const { id, content } = bySubject('Quarterly zebra report')
    expect(content.attachments).toEqual([
      { index: 0, name: 'chart.png', size: PNG.length, mime: 'image/png', isInline: false, isEmbeddedMessage: false },
    ])
    const data = await api.getAttachmentData('loose', id, 0)
    expect(data?.name).toBe('chart.png')
    expect(data?.mime).toBe('image/png')
    expect(new Uint8Array(data!.data)).toEqual(PNG)
  })

  test('importance and copies are read from the headers', () => {
    const { content } = bySubject('Fwd: Original walrus memo')
    expect(content.importance).toBe('high')
    expect(content.cc).toEqual([{ name: 'Carol Sender', email: 'carol@example.com' }])
  })

  test('an address hidden in an encoded name is never shown as the sender', async () => {
    const { content } = bySubject('Spoofed sender test')
    expect(content.fromEmail).toBe('attacker@evil.example')
    expect(content.fromName).toBe('IT Support <helpdesk@company.example>')
    expect(content.to).toEqual([
      { name: 'Éloïse', email: 'eloise@example.com' },
      { name: 'Boss <ceo@company.example>', email: 'intern@example.com' },
    ])
    const { messages } = await api.getFolderMessages('loose', 'msgfolder')
    expect(messages.find((m) => m.subject === 'Spoofed sender test')?.fromEmail).toBe('attacker@evil.example')
  })

  test('html is handed over as written, with its inline picture alongside', () => {
    // Making it safe is the page's job (sanitizeEmailHtml), so nothing is lost here.
    const { content } = bySubject('Hostile markup test')
    expect(content.html).toContain('<script>')
    expect(content.html).toContain('cid:inline-chart')
    expect(content.inlineImages).toHaveLength(1)
    expect(content.inlineImages[0].cid).toBe('inline-chart')
    expect(content.inlineImages[0].mime).toBe('image/png')
    expect(new Uint8Array(content.inlineImages[0].data)).toEqual(PNG)
    expect(content.attachments.map((a) => [a.isInline, a.cid])).toEqual([[true, 'inline-chart']])
  })
})

describe('a message attached to a message', () => {
  test('opens as a message of its own, with its own attachment', async () => {
    const { id, content } = bySubject('Fwd: Original walrus memo')
    expect(content.attachments).toMatchObject([
      { index: 0, name: 'Original walrus memo.eml', mime: 'message/rfc822', isEmbeddedMessage: true },
    ])
    const inner = await api.getEmbeddedMessageContent('loose', id, 0)
    expect(inner?.content).toMatchObject({
      subject: 'Original walrus memo',
      fromName: 'Dave Inner',
      fromEmail: 'dave@example.com',
      date: Date.UTC(2024, 2, 11, 8, 0),
    })
    expect(inner?.content.text).toContain('persimmon')
    expect(inner?.content.attachments.map((a) => a.name)).toEqual(['figures.csv'])
    const csv = await api.getAttachmentData('loose', inner!.id, 0)
    // A text attachment sent without an encoding has its line ends normalised
    // by the parser, so compare the lines rather than the bytes.
    expect(new TextDecoder().decode(csv!.data).trim().split(/\r?\n/)).toEqual(['walrus,count', 'atlantic,12'])
  })

  test('asking for an attachment that is not a message gives nothing', async () => {
    const { id } = bySubject('Quarterly zebra report')
    expect(await api.getEmbeddedMessageContent('loose', id, 0)).toBeNull()
    expect(await api.getEmbeddedMessageContent('loose', id, 5)).toBeNull()
  })
})

describe('a .msg message', () => {
  test('has its fields and body', () => {
    const { content } = bySubject('Distinctive msg subject wombat')
    expect(content).toMatchObject({
      itemKind: 'email',
      fromName: 'Carol Sender',
      fromEmail: 'carol@example.com',
      text: 'Body of the msg file. Distinctive keyword: pomegranate.',
      date: null,
      attachments: [],
    })
  })
})

describe('several mailboxes at once', () => {
  test('are kept apart, and closing one leaves the other', async () => {
    await api.openMsgSource('second', [fixture('mail.msg')])
    await api.indexSource('second')
    expect((await api.search('wombat')).map((h) => h.sourceId).sort()).toEqual(['loose', 'second'])

    await api.closeSource('second')
    expect((await api.search('wombat')).map((h) => h.sourceId)).toEqual(['loose'])
    expect(await api.getFolderMessages('second', 'msgfolder')).toEqual({ messages: [], unreadable: 0 })
    expect(await api.getMessageContent('second', 'msg0')).toBeNull()
    // The one still open is untouched.
    expect((await api.getFolderMessages('loose', 'msgfolder')).messages).toHaveLength(5)
  })

  test('a batch with nothing readable in it is refused with a reason', async () => {
    await expect(api.openMsgSource('junk', [fileOf('a.eml', 'nope'), fileOf('b.msg', 'nope')])).rejects.toThrow(
      'None of the files could be parsed as email messages.',
    )
    await expect(api.openMsgSource('junk', [fileOf('a.eml', 'nope')])).rejects.toThrow(
      'The file could not be parsed as an email message.',
    )
  })
})
