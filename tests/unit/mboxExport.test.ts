import { describe, expect, test } from 'vitest'
import { createFreshDirectory, MboxFolder, MboxrdEncoder, MboxTreeWriter } from '../../src/lib/bulkExport'
import type { EmlExportStep } from '../../src/types'
import { readMboxrd } from '../support/mboxrd'
import { MemoryFs, nameRefused, notAllowed, quotaExceeded, type MemoryFsOptions } from '../support/memory-fs'

const bytes = (s: string) => new TextEncoder().encode(s)
const text = (b: Uint8Array) => new TextDecoder().decode(b)

// The export's clock, for messages that have no date of their own.
const NOW = Date.UTC(2026, 9, 5, 21, 8, 48)

/** A small made-up message, with CRLF line endings as the .eml writer makes them. */
const message = (subject: string, body = `Body of ${subject}.`) =>
  `From: Alice Example <alice@example.com>\r\nSubject: ${subject}\r\n\r\n${body.replace(/\r?\n/g, '\r\n')}\r\n`

/** What a message is once its line endings are LF, as it is kept in an mbox file. */
const lf = (eml: string) => eml.replace(/\r\n/g, '\n')

/** An MBOX export into a fresh in-memory folder, with a writer to feed. */
async function setup(options: MemoryFsOptions = {}, label = 'Export') {
  const fs = new MemoryFs(options)
  const dir = await createFreshDirectory(fs.handle, label, 'Mailbox')
  const root = MboxFolder.root(dir, label)
  let cancelled = false
  const writer = new MboxTreeWriter(
    () => cancelled,
    () => NOW,
  )
  const step = (s: EmlExportStep, into: MboxFolder) => writer.step(s, () => into)
  /** Send one whole message, in the given pieces; false if the export should stop. */
  const save = async (into: MboxFolder, pieces: string | Uint8Array[], date: number | null = null) => {
    if (!(await step({ kind: 'start', subject: 's', date, folderId: 'f' }, into))) return false
    for (const piece of typeof pieces === 'string' ? [bytes(pieces)] : pieces) {
      if (!(await step({ kind: 'data', data: piece }, into))) return false
    }
    return step({ kind: 'end' }, into)
  }
  const out = () => fs.root.dir(dir.nameOnDisk)
  /** The messages in one .mbox file of the export, read back. */
  const read = (path: string) => {
    const parts = path.split('/')
    let d = out()
    for (const p of parts.slice(0, -1)) d = d.dir(p)
    return readMboxrd(d.file(parts.at(-1)!).text)
  }
  return { fs, dir, root, writer, step, save, read, out, cancel: () => (cancelled = true) }
}

/** Run the encoder over `data` cut into the given pieces. */
function encode(data: Uint8Array, cuts: number[] = []): string {
  const enc = new MboxrdEncoder()
  const out: Uint8Array[] = []
  let from = 0
  for (const cut of [...cuts, data.length]) {
    out.push(enc.push(data.subarray(from, cut)))
    from = cut
  }
  out.push(enc.end())
  return text(new Uint8Array(Buffer.concat(out)))
}

describe('the mboxrd form', () => {
  const tricky = message(
    'Lines that look like separators',
    ['From the start of a line', '>From after one quote', '>>From after two', 'not From here', ''].join('\n'),
  )

  test('lines starting with From, >From or >>From come back byte for byte', async () => {
    const { root, save, read, writer } = await setup()
    const inbox = root.child('Inbox')
    await save(inbox, tricky)
    await writer.discard()
    const [m] = read('Inbox.mbox')
    expect(m.message).toBe(lf(tricky))
  })

  test('in the file each of those lines has one more > in front', async () => {
    const { root, save, out, writer } = await setup()
    await save(root.child('Inbox'), tricky)
    await writer.discard()
    const file = out().file('Inbox.mbox').text
    expect(file).toContain('\n>From the start of a line\n')
    expect(file).toContain('\n>>From after one quote\n')
    expect(file).toContain('\n>>>From after two\n')
    expect(file).toContain('\nnot From here\n')
  })

  test('a line split between two pieces is quoted all the same, wherever the split falls', () => {
    const data = bytes(tricky)
    const whole = encode(data)
    expect(whole).toContain('\n>>>From after two\n')
    for (let cut = 0; cut <= data.length; cut++) expect(encode(data, [cut]), `split at ${cut}`).toBe(whole)
    // And one byte at a time.
    expect(encode(data, [...data.keys()].slice(1))).toBe(whole)
  })

  test('a CRLF split between two pieces becomes one LF, and a lone CR is kept', () => {
    const data = bytes('Subject: x\r\n\r\nline one\r\nhalf\rline\r\n')
    const expected = 'Subject: x\n\nline one\nhalf\rline\n\n'
    expect(encode(data)).toBe(expected)
    for (let cut = 0; cut <= data.length; cut++) expect(encode(data, [cut]), `split at ${cut}`).toBe(expected)
  })

  test('lines that only resemble a separator are left alone', () => {
    const lines = ['From: a header', ' From with a space first', 'Fromage', '>From', '>Fro', 'From', 'X From y', '\rFrom ']
    const data = bytes(`${lines.join('\r\n')}\r\n`)
    expect(encode(data)).toBe(`${lines.join('\n')}\n\n`)
  })

  test('a line of any number of > before From is quoted, split anywhere', () => {
    const quotes = '>'.repeat(100_000)
    const data = bytes(`${quotes}From x\r\n${quotes}Fro\r\n`)
    const expected = `>${quotes}From x\n${quotes}Fro\n\n`
    expect(encode(data)).toBe(expected)
    expect(encode(data, [50_000, 100_003, 150_000])).toBe(expected)
  })

  test('the very first line is quoted too if it needs it', () => {
    expect(encode(bytes('From someone\r\n'))).toBe('>From someone\n\n')
  })

  test('a message that does not end with a line break still ends with one and a blank line', () => {
    expect(encode(bytes('Subject: x\r\n\r\nno newline'))).toBe('Subject: x\n\nno newline\n\n')
    expect(encode(bytes('Subject: x\r\n\r\ncarriage return\r'))).toBe('Subject: x\n\ncarriage return\r\n\n')
    expect(encode(bytes('>Fr'))).toBe('>Fr\n\n')
  })

  test('each message starts with a From line giving its date, in asctime form and UTC', async () => {
    const { root, save, read, writer } = await setup()
    const inbox = root.child('Inbox')
    await save(inbox, message('one'), Date.UTC(2024, 2, 5, 7, 8, 9))
    await save(inbox, message('two'), Date.UTC(2001, 10, 23, 23, 59, 0))
    await writer.discard()
    expect(read('Inbox.mbox').map((m) => m.separator)).toEqual([
      'From MAILER-DAEMON Tue Mar  5 07:08:09 2024',
      'From MAILER-DAEMON Fri Nov 23 23:59:00 2001',
    ])
  })

  test('a message with no date, or one asctime cannot write, takes the time of the export', async () => {
    const { root, save, read, writer } = await setup()
    const inbox = root.child('Inbox')
    await save(inbox, message('none'), null)
    await save(inbox, message('far future'), 8.64e15)
    await save(inbox, message('not a number'), Number.NaN)
    await writer.discard()
    expect(read('Inbox.mbox').map((m) => m.separator)).toEqual(
      Array(3).fill('From MAILER-DAEMON Mon Oct  5 21:08:48 2026'),
    )
  })

  test('messages follow one another in the file, each complete', async () => {
    const { root, save, read, writer } = await setup()
    const inbox = root.child('Inbox')
    const sent = ['one', 'two', 'three'].map((s) => message(s))
    for (const m of sent) await save(inbox, [bytes(m.slice(0, 7)), bytes(m.slice(7))])
    await writer.discard()
    expect(read('Inbox.mbox').map((m) => m.message)).toEqual(sent.map(lf))
  })
})

describe('the folder tree', () => {
  test('a folder is Name.mbox, with its subfolders in Name.mbox.sbd beside it', async () => {
    const { root, save, out } = await setup()
    const inbox = root.child('Inbox', 1)
    const project = inbox.child('Project')
    await save(inbox, message('in the inbox'))
    await save(project, message('in the project'))
    await save(root.child('Sent'), message('sent'))
    expect(out().tree()).toEqual([
      'Inbox.mbox',
      'Inbox.mbox.sbd/',
      'Inbox.mbox.sbd/Project.mbox',
      'Sent.mbox',
    ])
  })

  test('a folder with no mail of its own gets an empty file, so its subfolders can be found', async () => {
    const { root, save, out } = await setup()
    const a = root.child('Archive', 2)
    const year = a.child('2024', 1)
    await save(year.child('March'), message('deep'))
    expect(out().tree()).toEqual([
      'Archive.mbox.sbd/',
      'Archive.mbox.sbd/2024.mbox.sbd/',
      'Archive.mbox.sbd/2024.mbox.sbd/March.mbox',
      'Archive.mbox.sbd/2024.mbox',
      'Archive.mbox',
    ])
    expect(out().file('Archive.mbox').content).toHaveLength(0)
  })

  test('a folder with nothing saved leaves nothing behind', async () => {
    const { root, step, save, writer, out } = await setup()
    const empty = root.child('Empty')
    root.child('Untouched')
    await step({ kind: 'start', subject: 's', date: null, folderId: 'f' }, empty)
    await step({ kind: 'skip' }, empty)
    await save(root.child('Inbox'), message('kept'))
    await writer.discard()
    expect(out().tree()).toEqual(['Inbox.mbox'])
    expect(writer.unreadable).toBe(1)
  })

  test('the mail of the top itself goes in a file named after the export', async () => {
    const { root, save, out, writer } = await setup({}, 'Mailbox name')
    await save(root, message('kept in the top'))
    await save(root.child('Inbox'), message('in the inbox'))
    await writer.discard()
    expect(out().tree().sort()).toEqual(['Inbox.mbox', 'Mailbox name.mbox'])
  })

  test('folders with the same name, or names a disk would confuse, are numbered, file and .sbd together', async () => {
    const { root, save, out } = await setup()
    const first = root.child('Reports', 1)
    const second = root.child('reports', 1)
    await save(first.child('Q1'), message('first'))
    await save(second.child('Q1'), message('second'))
    expect(out().tree().sort()).toEqual([
      'Reports.mbox',
      'Reports.mbox.sbd/',
      'Reports.mbox.sbd/Q1.mbox',
      'reports (2).mbox',
      'reports (2).mbox.sbd/',
      'reports (2).mbox.sbd/Q1.mbox',
    ])
  })

  test('a folder name from the mail is made safe, and its dots do not make a second extension', async () => {
    const { root, save, out } = await setup()
    const names = ['../../etc', 'CON', 'name@example.com', 'a:b*c?', ' .hidden. ', 'invoice‮gpj.exe', '']
    for (const n of names) await save(root.child(n), message(n))
    const files = out().list()
    expect(files).toHaveLength(names.length)
    for (const f of files) {
      expect(f).toMatch(/^[^.<>:"/\\|?*\u0000-\u001f‮]+\.mbox$/)
      expect(f).not.toMatch(/^(con|prn|aux|nul)\./i)
      expect(f).toBe(f.trim())
    }
    expect(files).toContain('name@example_com.mbox')
  })

  test('sibling folders named X, X.mbox and X.mbox.sbd do not run into one another', async () => {
    const { root, save, read, out, writer } = await setup()
    for (const n of ['X', 'X.mbox', 'X.mbox.sbd']) await save(root.child(n, 1).child('Sub'), message(n))
    await writer.discard()
    expect(out().tree().sort()).toEqual([
      'X.mbox',
      'X.mbox.sbd/',
      'X.mbox.sbd/Sub.mbox',
      'X_mbox.mbox',
      'X_mbox.mbox.sbd/',
      'X_mbox.mbox.sbd/Sub.mbox',
      'X_mbox_sbd.mbox',
      'X_mbox_sbd.mbox.sbd/',
      'X_mbox_sbd.mbox.sbd/Sub.mbox',
    ])
    expect(read('X_mbox.mbox.sbd/Sub.mbox').map((m) => m.message)).toEqual([lf(message('X.mbox'))])
  })

  test('however deep and long-named the folders, every path stays short enough for Windows', async () => {
    const { dir, root, save, fs } = await setup({}, 'x'.repeat(200))
    expect(dir.nameOnDisk.length).toBe(40)
    let folder = root
    const depth = 6
    for (let level = 0; level < depth; level++) {
      folder = folder.child(`level ${level} ${'long name '.repeat(20)}`, depth - level - 1)
      await save(folder, message(`at level ${level}`))
    }
    const paths = fs.root.tree().filter((p) => !p.endsWith('/'))
    expect(paths).toHaveLength(depth)
    for (const p of paths) expect(p.length, p).toBeLessThanOrEqual(160)
  })

  test('an export of one folder is that folder\'s file, with its subfolders beside it', async () => {
    const fs = new MemoryFs()
    const dir = await createFreshDirectory(fs.handle, 'Inbox', 'Mailbox')
    const inbox = MboxFolder.root(dir, 'Inbox').child('Inbox', 1)
    const writer = new MboxTreeWriter(() => false)
    for (const [into, s] of [
      [inbox, 'one'],
      [inbox.child('Sub'), 'two'],
    ] as const) {
      await writer.step({ kind: 'start', subject: s, date: null, folderId: s }, () => into)
      await writer.step({ kind: 'data', data: bytes(message(s)) }, () => into)
      await writer.step({ kind: 'end' }, () => into)
    }
    await writer.discard()
    expect(fs.root.tree()).toEqual(['Inbox/', 'Inbox/Inbox.mbox', 'Inbox/Inbox.mbox.sbd/', 'Inbox/Inbox.mbox.sbd/Sub.mbox'])
  })
})

describe('what is already on disk', () => {
  test('a file the disk already has under that name, by its own rules, is never written over', async () => {
    const { root, save, out, writer } = await setup({ caseInsensitive: true })
    const inbox = root.child('Inbox')
    const there = out().seedFile('INBOX.MBOX', 'already here')
    await save(inbox, message('new'))
    await writer.discard()
    expect(there.text).toBe('already here')
    expect(out().list().sort()).toEqual(['INBOX.MBOX', 'Inbox (2).mbox'])
  })

  test('a folder that comes back later in the export is added to, not started again', async () => {
    const { root, save, read, out, writer } = await setup()
    const a = root.child('A')
    const b = root.child('B')
    await save(a, message('a one'))
    await save(b, message('b one'))
    await save(a, message('a two'))
    await writer.discard()
    expect(read('A.mbox').map((m) => m.message)).toEqual([lf(message('a one')), lf(message('a two'))])
    expect(read('B.mbox')).toHaveLength(1)
    expect(out().file('A.mbox').commits).toBe(2)
  })
})

describe('a message that does not finish', () => {
  test('a message found unreadable part-way is cut out of the file, and those before it stay', async () => {
    const { root, step, save, read, writer } = await setup()
    const inbox = root.child('Inbox')
    await save(inbox, message('complete'))
    await step({ kind: 'start', subject: 's', date: null, folderId: 'f' }, inbox)
    await step({ kind: 'data', data: bytes(message('half').slice(0, 30)) }, inbox)
    await step({ kind: 'skip' }, inbox)
    await save(inbox, message('after'))
    await writer.discard()
    expect(read('Inbox.mbox').map((m) => m.message)).toEqual([lf(message('complete')), lf(message('after'))])
    expect([writer.exported, writer.unreadable, writer.unsaved]).toEqual([2, 1, 0])
  })

  test('a new message starting before the last one ended drops the unfinished one', async () => {
    const { root, step, save, read, writer } = await setup()
    const inbox = root.child('Inbox')
    await step({ kind: 'start', subject: 's', date: null, folderId: 'f' }, inbox)
    await step({ kind: 'data', data: bytes('From: partial') }, inbox)
    await save(inbox, message('whole'))
    await writer.discard()
    expect(read('Inbox.mbox').map((m) => m.message)).toEqual([lf(message('whole'))])
  })

  test('cancelling part-way through a message cuts it off and keeps every complete one', async () => {
    const { root, step, save, read, writer, cancel, out } = await setup()
    const inbox = root.child('Inbox')
    await save(inbox, message('one'))
    await save(inbox, message('two'))
    await step({ kind: 'start', subject: 's', date: null, folderId: 'f' }, inbox)
    await step({ kind: 'data', data: bytes(message('three').slice(0, 40)) }, inbox)
    cancel()
    expect(await step({ kind: 'data', data: bytes('more') }, inbox)).toBe(false)
    // The file is closed, so what it holds is on disk.
    expect(out().file('Inbox.mbox').commits).toBe(1)
    expect(read('Inbox.mbox').map((m) => m.message)).toEqual([lf(message('one')), lf(message('two'))])
    expect(writer.exported).toBe(2)
    await writer.discard()
    expect(out().file('Inbox.mbox').commits).toBe(1)
  })

  test('cancelling between folders leaves every finished file as it was', async () => {
    const { root, save, read, writer, cancel } = await setup()
    await save(root.child('A'), message('a'))
    await save(root.child('B'), message('b'))
    cancel()
    expect(await save(root.child('C'), message('c'))).toBe(false)
    expect(read('A.mbox')).toHaveLength(1)
    expect(read('B.mbox')).toHaveLength(1)
    expect(writer.exported).toBe(2)
  })
})

describe('when saving fails', () => {
  test('a write that fails gives up the new file and its messages, and the export goes on in a new one', async () => {
    let writes = 0
    const { root, save, read, writer, out } = await setup({
      fail: (op) => (op === 'write' && ++writes === 5 ? new DOMException('Disk hiccup.', 'InvalidStateError') : null),
    })
    const inbox = root.child('Inbox')
    await save(inbox, message('one'))
    expect(await save(inbox, [bytes('From: x\r\n'), bytes('Subject: two\r\n\r\nbody\r\n')])).toBe(true)
    // The browser errors the stream, so the file that was new is removed, and
    // "one", written to it before, is counted as not saved too.
    expect(out().list()).toEqual([])
    await save(inbox, message('three'))
    await writer.discard()
    expect(read('Inbox.mbox').map((m) => m.message)).toEqual([lf(message('three'))])
    expect([writer.exported, writer.unsaved]).toEqual([1, 2])
    expect([...writer.reasons]).toEqual([['Disk hiccup.', 2]])
  })

  test('a write that fails in a file opened again takes it back to what it held when opened', async () => {
    let aWrites = 0
    const { root, save, read, writer } = await setup({
      fail: (op, name) =>
        op === 'write' && name === 'A.mbox' && ++aWrites === 8 ? new DOMException('Disk hiccup.', 'InvalidStateError') : null,
    })
    const a = root.child('A')
    await save(a, message('a one'))
    await save(root.child('B'), message('b'))
    await save(a, message('a two'))
    expect(await save(a, message('a three'))).toBe(true)
    await writer.discard()
    expect(read('A.mbox').map((m) => m.message)).toEqual([lf(message('a one'))])
    expect(read('B.mbox')).toHaveLength(1)
    expect([writer.exported, writer.unsaved]).toEqual([2, 2])
  })

  test('after a failed write the file is not cut back, since the browser would refuse that too', async () => {
    let writes = 0
    const ops: string[] = []
    const { root, save, writer } = await setup({
      fail: (op) => {
        ops.push(op)
        return op === 'write' && ++writes === 2 ? new DOMException('Disk hiccup.', 'InvalidStateError') : null
      },
    })
    await save(root.child('Inbox'), message('one'))
    await writer.discard()
    expect(ops).not.toContain('truncate')
    expect(ops).not.toContain('close')
    expect(ops.at(-1)).toBe('remove')
  })

  test('if the file cannot be cut back, the messages in it are counted as not saved', async () => {
    const { root, step, save, writer, out } = await setup({
      fail: (op) => (op === 'truncate' ? new DOMException('Broken.', 'InvalidStateError') : null),
    })
    const inbox = root.child('Inbox')
    await save(inbox, message('one'))
    await save(inbox, message('two'))
    await step({ kind: 'start', subject: 's', date: null, folderId: 'f' }, inbox)
    await step({ kind: 'data', data: bytes(message('three').slice(0, 30)) }, inbox)
    expect(await step({ kind: 'skip' }, inbox)).toBe(true)
    await writer.discard()
    // The new file was given up and removed; nothing in it was complete on disk.
    expect(out().list()).toEqual([])
    expect([writer.exported, writer.unsaved]).toEqual([0, 3])
  })

  test('if the file cannot be closed, its messages are counted as not saved and it is removed', async () => {
    const { root, save, writer, out } = await setup({
      fail: (op, name) => (op === 'close' && name === 'A.mbox' ? new DOMException('Could not close.', 'InvalidStateError') : null),
    })
    const a = root.child('A')
    await save(a, message('a one'))
    await save(a, message('a two'))
    await save(root.child('B'), message('b'))
    await writer.discard()
    expect(out().list()).toEqual(['B.mbox'])
    expect([writer.exported, writer.unsaved]).toEqual([1, 2])
    expect([...writer.reasons]).toEqual([['Could not close.', 2]])
  })

  test('a file opened again that cannot be closed goes back to what it held', async () => {
    let aCloses = 0
    const { root, save, read, writer } = await setup({
      fail: (op, name) =>
        op === 'close' && name === 'A.mbox' && ++aCloses === 2 ? new DOMException('Nope.', 'InvalidStateError') : null,
    })
    const a = root.child('A')
    await save(a, message('a one'))
    await save(root.child('B'), message('b'))
    await save(a, message('a two'))
    await writer.discard()
    expect(read('A.mbox').map((m) => m.message)).toEqual([lf(message('a one'))])
    expect([writer.exported, writer.unsaved]).toEqual([2, 1])
  })

  test('a file that cannot be opened again leaves its folder\'s later messages out, and keeps the earlier ones', async () => {
    let opens = 0
    const { root, save, read, writer } = await setup({
      fail: (op, name) => (op === 'seek' && name === 'A.mbox' && ++opens === 1 ? new DOMException('Busy.', 'InvalidStateError') : null),
    })
    const a = root.child('A')
    await save(a, message('a one'))
    await save(root.child('B'), message('b'))
    await save(a, message('a two'))
    await save(a, message('a three'))
    await writer.discard()
    expect(read('A.mbox').map((m) => m.message)).toEqual([lf(message('a one')), lf(message('a three'))])
    expect([writer.exported, writer.unsaved]).toEqual([3, 1])
  })

  test('a full disk stops the export: finished folders are kept, and the folder being written is lost', async () => {
    let writes = 0
    const { root, save, read, writer, out } = await setup({
      fail: (op) => (op === 'write' && ++writes === 11 ? quotaExceeded() : null),
    })
    await save(root.child('Done'), message('done'))
    const inbox = root.child('Inbox')
    await save(inbox, message('one'))
    await save(inbox, message('two'))
    expect(await save(inbox, message('three'))).toBe(false)
    expect(writer.fatal).toBe('The disk is full.')
    expect(await save(inbox, message('four'))).toBe(false)
    await writer.discard()
    expect(read('Done.mbox')).toHaveLength(1)
    expect(out().list()).toEqual(['Done.mbox'])
    // "one" and "two" are counted as not saved; "three", the message the
    // export stopped on, is not counted, as in the .eml export.
    expect([writer.exported, writer.unsaved]).toEqual([1, 2])
    expect([...writer.reasons]).toEqual([['The disk is full.', 2]])
  })

  test('a disk that fills up as the last file is closed stops the export with its reason', async () => {
    const { root, save, writer } = await setup({ fail: (op) => (op === 'close' ? quotaExceeded() : null) })
    await save(root.child('Inbox'), message('one'))
    await writer.discard()
    expect(writer.fatal).toBe('The disk is full.')
    expect([writer.exported, writer.unsaved]).toEqual([0, 1])
  })

  test('as does one that fills up when the next folder starts', async () => {
    const { root, save, writer } = await setup({
      fail: (op, name) => (op === 'close' && name === 'A.mbox' ? quotaExceeded() : null),
    })
    await save(root.child('A'), message('a'))
    expect(await save(root.child('B'), message('b'))).toBe(false)
    expect(writer.fatal).toBe('The disk is full.')
  })

  test('a refused file name is tried once more as Folder.mbox', async () => {
    const { root, save, read, writer } = await setup({
      fail: (op, name) => (op === 'createFile' && name === 'Odd name.mbox' ? nameRefused() : null),
    })
    await save(root.child('Odd name'), message('one'))
    await writer.discard()
    expect(read('Folder.mbox')).toHaveLength(1)
    expect(writer.unsaved).toBe(0)
  })

  test('a folder whose file cannot be created at all has its messages counted, once each, and the export goes on', async () => {
    let creates = 0
    const { root, save, read, writer } = await setup({
      fail: (op, name) => {
        if (op === 'createFile' && name !== 'Good.mbox') creates++
        return op === 'createFile' && name !== 'Good.mbox' ? nameRefused() : null
      },
    })
    const bad = root.child('Bad')
    for (let i = 0; i < 25; i++) expect(await save(bad, message(`bad ${i}`))).toBe(true)
    await save(root.child('Good'), message('good'))
    await writer.discard()
    expect(read('Good.mbox')).toHaveLength(1)
    expect([writer.exported, writer.unsaved]).toEqual([1, 25])
    // Tried under its own name and a plain one, then not again for every message.
    expect(creates).toBe(2)
    expect(writer.fatal).toBeNull()
  })

  test('a file that cannot be opened for writing does not leave an empty file', async () => {
    const { root, save, writer, out } = await setup({
      fail: (op) => (op === 'openWritable' ? new DOMException('Locked.', 'NoModificationAllowedError') : null),
    })
    await save(root.child('Inbox'), message('one'))
    await writer.discard()
    expect(out().list()).toEqual([])
    expect(writer.unsaved).toBe(1)
  })

  test('twenty failures in a row, in a folder that was working, stop the export', async () => {
    let writes = 0
    const { root, save, writer } = await setup({
      fail: (op) => (op === 'write' && ++writes > 3 ? new DOMException('Gone.', 'NotFoundError') : null),
    })
    const inbox = root.child('Inbox')
    await save(inbox, message('ok'))
    let carriedOn = 0
    while (await save(inbox, message('failing'))) carriedOn++
    expect(carriedOn).toBe(MboxTreeWriter.MAX_IN_A_ROW - 1)
    expect(writer.fatal).toBe('20 messages in a row could not be saved (Gone)')
  })

  test('a failure while a subfolder\'s parent is given its empty file costs only that', async () => {
    const { root, save, read, writer, out } = await setup({
      fail: (op, name) => (op === 'createFile' && name !== 'Child.mbox' ? nameRefused() : null),
    })
    const parent = root.child('Parent', 1)
    await save(parent.child('Child'), message('child'))
    await writer.discard()
    expect(read('Parent.mbox.sbd/Child.mbox')).toHaveLength(1)
    expect(out().list()).toEqual(['Parent.mbox.sbd'])
    expect(writer.unsaved).toBe(0)
  })

  test('but losing permission then stops the export', async () => {
    const { root, save, writer } = await setup({
      fail: (op, name) => (op === 'createFile' && name === 'Parent.mbox' ? notAllowed() : null),
    })
    expect(await save(root.child('Parent', 1).child('Child'), message('child'))).toBe(false)
    expect(writer.fatal).toBe('Permission was withdrawn.')
  })

  test('as does losing it while opening a folder\'s file', async () => {
    const { root, save, writer } = await setup({ fail: (op) => (op === 'createFile' ? notAllowed() : null) })
    expect(await save(root.child('Inbox'), message('one'))).toBe(false)
    expect(writer.fatal).toBe('Permission was withdrawn.')
  })

  test('a parent\'s empty file is not kept for a subfolder whose messages were all lost', async () => {
    let childWrites = 0
    const { root, step, save, writer, out } = await setup({
      fail: (op, name) =>
        op === 'write' && name === 'Child.mbox' && ++childWrites === 4 ? new DOMException('Disk hiccup.', 'InvalidStateError') : null,
    })
    const parent = root.child('Parent', 1)
    const child = parent.child('Child')
    await save(child, message('child one'))
    expect(out().list()).toContain('Parent.mbox')
    await save(child, message('child two'))
    // The parent's own message turns out unreadable, so its file is empty when closed.
    await step({ kind: 'start', subject: 's', date: null, folderId: 'f' }, parent)
    await step({ kind: 'skip' }, parent)
    await writer.discard()
    expect(out().tree()).toEqual(['Parent.mbox.sbd/'])
    expect([writer.exported, writer.unsaved, writer.unreadable]).toEqual([0, 2, 1])
  })

  test('a parent whose empty file cannot be closed is left without one', async () => {
    const { root, save, read, writer, out } = await setup({
      fail: (op, name) => (op === 'close' && name === 'Parent.mbox' ? new DOMException('No.', 'InvalidStateError') : null),
    })
    await save(root.child('Parent', 1).child('Child'), message('child'))
    await writer.discard()
    expect(read('Parent.mbox.sbd/Child.mbox')).toHaveLength(1)
    expect(out().list()).toEqual(['Parent.mbox.sbd'])
  })
})

describe('the reader these tests use', () => {
  test('does object to a file that is not mboxrd as written here', () => {
    expect(() => readMboxrd('From x\r\nSubject: a\r\n\r\n')).toThrow('CRLF')
    expect(() => readMboxrd('From x\nSubject: a\n')).toThrow('blank line')
    expect(() => readMboxrd('Subject: a\n\n')).toThrow('From line')
    expect(readMboxrd('From x\n>>From y\n\nFrom z\nb\n\n')).toEqual([
      { separator: 'From x', message: '>From y\n' },
      { separator: 'From z', message: 'b\n' },
    ])
  })
})
