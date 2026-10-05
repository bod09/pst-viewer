import PostalMime, { type Email } from 'postal-mime'
import { beforeAll, describe, expect, test } from 'vitest'
import type { PstWorkerApi } from '../../src/worker/pst.worker'
import type { EmlExportStep } from '../../src/types'
import { PNG } from '../support/fixtures.mjs'
import { fileOf, fixture } from '../support/files'
import { loadWorker } from '../support/worker'

let api: PstWorkerApi

interface Exported {
  subject: string
  date: number | null
  folderId: string
  bytes: Uint8Array
  email: Email
}

/** Collect what an export sends into whole messages, as a writer would. */
function collector(stopAfter = Infinity) {
  const steps: EmlExportStep['kind'][] = []
  const done: Omit<Exported, 'email'>[] = []
  let current: { subject: string; date: number | null; folderId: string; pieces: Uint8Array[] } | null = null
  let skipped = 0
  const sink = async (step: EmlExportStep): Promise<boolean> => {
    steps.push(step.kind)
    if (step.kind === 'start') current = { subject: step.subject, date: step.date, folderId: step.folderId, pieces: [] }
    else if (step.kind === 'data') current?.pieces.push(step.data)
    else if (step.kind === 'end' && current) {
      done.push({ ...current, bytes: new Uint8Array(Buffer.concat(current.pieces)) })
      current = null
    } else if (step.kind === 'skip') {
      skipped++
      current = null
    }
    return done.length < stopAfter
  }
  const parsed = async (): Promise<Exported[]> =>
    Promise.all(
      done.map(async (d) => ({
        ...d,
        email: await PostalMime.parse(d.bytes, { attachmentEncoding: 'arraybuffer', rfc822Attachments: true }),
      })),
    )
  return { sink, steps, parsed, skipped: () => skipped }
}

beforeAll(async () => {
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

describe('exporting a folder', () => {
  test('every message comes out as a complete .eml, in order', async () => {
    const out = collector()
    const result = await api.exportFolderEml('loose', 'msgfolder', out.sink)
    const messages = await out.parsed()
    expect(messages.map((m) => m.subject)).toEqual([
      'Quarterly zebra report',
      'Spoofed sender test',
      'Fwd: Original walrus memo',
      'Hostile markup test',
      'Distinctive msg subject wombat',
    ])
    expect(messages.every((m) => m.folderId === 'msgfolder')).toBe(true)
    // The file that was not mail is reported, so the summary can say one was left out.
    expect(result).toEqual({ notListed: 1 })
    // Each message is a start, some data, and an end; nothing is interleaved.
    expect(out.steps.join(' ')).toMatch(/^(start (data )+end ?)+$/)
  })

  test('what comes out says what went in', async () => {
    const out = collector()
    await api.exportFolderEml('loose', 'msgfolder', out.sink)
    const [zebra, , forwarded, hostile, msg] = await out.parsed()

    // Kept headers are the originals, word for word.
    expect(zebra.email.subject).toBe('Quarterly zebra report')
    expect(zebra.email.from).toEqual({ name: 'Alice Example', address: 'alice@example.com' })
    expect(zebra.email.date).toBe('2024-03-12T10:15:00.000Z')
    expect(zebra.date).toBe(Date.UTC(2024, 2, 12, 10, 15))
    expect(zebra.email.text).toContain('pomegranate')
    expect(zebra.email.attachments.map((a) => [a.filename, a.mimeType])).toEqual([['chart.png', 'image/png']])
    expect(new Uint8Array(zebra.email.attachments[0].content as ArrayBuffer)).toEqual(PNG)

    // An inline picture stays an inline picture.
    expect(hostile.email.html).toContain('cid:inline-chart')
    expect(hostile.email.attachments.map((a) => [a.disposition, a.contentId])).toEqual([['inline', '<inline-chart>']])

    // A .msg has no transport headers, so they are written from its fields.
    expect(msg.email.subject).toBe('Distinctive msg subject wombat')
    expect(msg.email.from).toEqual({ name: 'Carol Sender', address: 'carol@example.com' })
    expect(msg.email.text).toContain('Body of the msg file.')
    expect(msg.date).toBeNull()

    // A forwarded message is still attached, as a message that opens.
    expect(forwarded.email.attachments.map((a) => [a.filename, a.mimeType])).toEqual([
      ['Original walrus memo.eml', 'message/rfc822'],
    ])
    const inner = await PostalMime.parse(forwarded.email.attachments[0].content as ArrayBuffer, {
      attachmentEncoding: 'arraybuffer',
    })
    expect(inner.subject).toBe('Original walrus memo')
    expect(inner.text).toContain('persimmon')
    expect(inner.attachments.map((a) => a.filename)).toEqual(['figures.csv'])
  })

  test('the spoofed sender is exported as it really is', async () => {
    const out = collector()
    await api.exportFolderEml('loose', 'msgfolder', out.sink)
    const spoof = (await out.parsed())[1]
    // The original header is kept, so reading it back correctly is the reader's job;
    // this app's own reader gets it right.
    await api.openMsgSource('reopened', [fileOf('spoof.eml', spoof.bytes)])
    const [listed] = (await api.getFolderMessages('reopened', 'msgfolder')).messages
    expect(listed.fromEmail).toBe('attacker@evil.example')
    expect(listed.fromName).toBe('IT Support <helpdesk@company.example>')
    await api.closeSource('reopened')
  })

  test('an exported message opens again as the same message', async () => {
    const out = collector()
    await api.exportFolderEml('loose', 'msgfolder', out.sink)
    const exported = await out.parsed()
    await api.openMsgSource(
      'round-trip',
      exported.map((m, i) => fileOf(`${i}.eml`, m.bytes)),
    )
    const before = (await api.getFolderMessages('loose', 'msgfolder')).messages
    const after = (await api.getFolderMessages('round-trip', 'msgfolder')).messages
    const shown = (m: (typeof before)[number]) => [m.subject, m.fromName, m.fromEmail, m.to, m.date, m.hasAttachments]
    expect(after.map(shown)).toEqual(before.map(shown))
    for (const [i, m] of before.entries()) {
      const a = await api.getMessageContent('loose', m.id)
      const b = await api.getMessageContent('round-trip', after[i].id)
      expect(b?.text?.trim() ?? null, m.subject).toBe(a?.text?.trim() ?? null)
      expect(b?.html ?? null, m.subject).toBe(a?.html ?? null)
      // An attached message is rebuilt on the way out, so its size may change;
      // a file's may not.
      const files = (c: typeof a) =>
        c?.attachments.map((x) => [x.name, x.isInline, x.isEmbeddedMessage ? 'message' : x.size])
      expect(files(b), m.subject).toEqual(files(a))
    }
    await api.closeSource('round-trip')
  })

  test('stops as soon as the receiver says so', async () => {
    const out = collector(2)
    await api.exportFolderEml('loose', 'msgfolder', out.sink)
    expect((await out.parsed()).map((m) => m.subject)).toEqual(['Quarterly zebra report', 'Spoofed sender test'])
    expect(out.steps.filter((s) => s === 'start')).toHaveLength(2)
  })

  test('a folder or mailbox that is not there exports nothing', async () => {
    const out = collector()
    await api.exportFolderEml('loose', 'no-such-folder', out.sink)
    await expect(api.exportFolderEml('no-such-mailbox', 'msgfolder', out.sink)).rejects.toThrow(
      'This mailbox is no longer open.',
    )
    expect(out.steps).toEqual([])
  })

  test('exporting twice gives the same messages, and leaves the mailbox usable', async () => {
    const first = collector()
    const second = collector()
    await api.exportFolderEml('loose', 'msgfolder', first.sink)
    await api.exportFolderEml('loose', 'msgfolder', second.sink)
    const summary = async (c: ReturnType<typeof collector>) =>
      (await c.parsed()).map((m) => [m.subject, m.email.text?.length, m.email.attachments.map((a) => a.filename)])
    expect(await summary(second)).toEqual(await summary(first))
    const data = await api.getAttachmentData('loose', 'msg0', 0)
    expect(new Uint8Array(data!.data)).toEqual(PNG)
  })
})

describe('exporting one message', () => {
  test('gives the same file the folder export does', async () => {
    const whole = collector()
    await api.exportFolderEml('loose', 'msgfolder', whole.sink)
    const single = collector()
    await api.exportMessageEml('loose', 'msg0', single.sink)
    const [a] = await single.parsed()
    const [b] = await whole.parsed()
    // Identical apart from the random boundary between the parts.
    const stable = (bytes: Uint8Array) => new TextDecoder().decode(bytes).replace(/=_pstv_mix_[a-z0-9]+/g, 'BOUNDARY')
    expect(stable(a.bytes)).toBe(stable(b.bytes))
    expect(a.folderId).toBe('msgfolder')
  })

  test('a message that is not there is reported as skipped', async () => {
    const out = collector()
    await api.exportMessageEml('loose', 'no-such-message', out.sink)
    await api.exportMessageEml('no-such-mailbox', 'msg0', out.sink)
    expect(out.steps).toEqual(['skip', 'skip'])
  })
})
