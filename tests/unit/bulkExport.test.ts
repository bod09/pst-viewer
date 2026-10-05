import { afterEach, describe, expect, test, vi } from 'vitest'
import {
  canExportToFolder,
  createFreshDirectory,
  describeError,
  EmlTreeWriter,
  ExportDirectory,
  pickExportFolder,
} from '../../src/lib/bulkExport'
import { MemoryFs, nameRefused, notAllowed, quotaExceeded, type MemoryFsOptions } from '../support/memory-fs'

const bytes = (s: string) => new TextEncoder().encode(s)

/** An export into a fresh in-memory folder, with a writer to feed. */
async function setup(options: MemoryFsOptions = {}, label = 'Export') {
  const fs = new MemoryFs(options)
  const dir = await createFreshDirectory(fs.handle, label, 'Mailbox')
  let cancelled = false
  const writer = new EmlTreeWriter(() => cancelled)
  /** Send one whole message through the writer; false if the export should stop. */
  const save = async (
    subject: string,
    date: number | null = null,
    into: ExportDirectory = dir,
    body = `body of ${subject.toWellFormed()}`,
  ): Promise<boolean> => {
    const dirOf = () => into
    if (!(await writer.step({ kind: 'start', subject, date, folderId: 'f' }, dirOf))) return false
    if (!(await writer.step({ kind: 'data', data: bytes(body) }, dirOf))) return false
    return writer.step({ kind: 'end' }, dirOf)
  }
  return { fs, dir, writer, save, cancel: () => (cancelled = true), out: () => fs.root.dir(dir.nameOnDisk) }
}

/**
 * Whether a name is safe to create on Windows, macOS and Linux, and accepted
 * by Chromium. Written from the platforms' own rules, apart from the code
 * under test, so that a mistake there is not copied here.
 */
function problemsWith(name: string): string[] {
  const problems: string[] = []
  if (name.length === 0) problems.push('empty')
  if (/[\u0000-\u001f\u007f-\u009f]/.test(name)) problems.push('control character')
  if (/["*/:<>?\\|]/.test(name)) problems.push('reserved character')
  if (/\p{Cf}/u.test(name)) problems.push('invisible or direction-changing character')
  if (/[\u2028\u2029]/.test(name)) problems.push('line separator')
  if (name !== name.trim()) problems.push('leading or trailing space')
  if (/^[.~]|[.~ ]$/.test(name)) problems.push('leading or trailing dot or tilde')
  // Devices, with or without an extension, and with spaces before the dot.
  if (/^(con|prn|aux|nul|clock\$|conin\$|conout\$|com[0-9\u00b9\u00b2\u00b3]|lpt[0-9\u00b9\u00b2\u00b3])\s*(\.|$)/i.test(name)) {
    problems.push('device name')
  }
  // Code points Unicode sets aside as "not a character", which Chromium refuses.
  const nonCharacter = (cp: number) => (cp >= 0xfdd0 && cp <= 0xfdef) || (cp & 0xfffe) === 0xfffe
  if ([...name].some((ch) => nonCharacter(ch.codePointAt(0)!))) problems.push('non-character')
  // A name Windows could take for another file's 8.3 short name, like GIT~1.
  if (name.includes('~') && /^[^\s."\\/:+|<>=;?,*]{1,8}(\.[^\s."\\/:+|<>=;?,*]{0,3})?$/.test(name)) {
    problems.push('could be a short name')
  }
  if (/^(desktop\.ini|thumbs\.db)$/i.test(name)) problems.push('shell name')
  if (!name.isWellFormed()) problems.push('unpaired surrogate')
  if (name.length > 72) problems.push(`${name.length} units long`)
  if (Buffer.byteLength(name) > 140) problems.push(`${Buffer.byteLength(name)} bytes long`)
  if (name === '.' || name === '..') problems.push('dot name')
  return problems
}

const HOSTILE = [
  '../../../etc/passwd',
  '..\\..\\Windows\\System32\\config',
  '/absolute/path',
  'C:\\Users\\bob\\evil.exe',
  'a/b\\c:d*e?f"g<h>i|j',
  'CON',
  'con',
  'PRN.txt',
  'aux.eml',
  'NUL',
  'COM1',
  'LPT9.anything.at.all',
  'CLOCK$',
  'CONIN$',
  'conout$',
  'COM\u00b9',
  'LPT\u00b3.txt',
  'CON .txt',
  'a~1',
  'x\u{1FFFE}y\u{10FFFF}',
  'desktop.ini',
  'Thumbs.db',
  '.hidden',
  '...',
  '..',
  '.',
  '~',
  '~$temp',
  'trailing dot.',
  'trailing space ',
  '  leading space',
  'invoice\u202Egpj.exe', // right-to-left override: shows as "invoiceexe.jpg"
  'zero\u200Bwidth\u200Djoiner\uFEFF',
  'null\u0000byte and \u001f control',
  'line\nbreak\r\nand\ttab',
  'line\u2028separator\u2029paragraph',
  'lone \uD800 high and \uDC00 low surrogate',
  'non\uFFFEcharacter\uFDD0',
  'emoji \u{1F600}\u{1F468}\u200D\u{1F469}\u200D\u{1F467} family',
  '日本語の件名',
  'Ünïcödé \u2013 ñame',
  'GIT~1',
  'PROGRA~1.EXE',
  'a~1',
  '???',
  '',
  '   ',
  'x'.repeat(500),
  '語'.repeat(300),
  '\u{1F600}'.repeat(200),
  `${'long '.repeat(40)}.eml`,
]

afterEach(() => vi.unstubAllGlobals())

describe('file names', () => {
  test.each(HOSTILE.map((s) => [JSON.stringify(s).slice(0, 60), s]))(
    'a subject of %s becomes a safe file name',
    async (_shown, subject) => {
      const { save, writer, out } = await setup()
      expect(await save(subject)).toBe(true)
      expect(writer.exported).toBe(1)
      const [name] = out().list()
      expect(problemsWith(name), name).toEqual([])
      expect(name.endsWith('.eml')).toBe(true)
      // Exactly one file, directly in the export folder: nothing escaped it.
      expect(out().tree()).toEqual([name])
      expect(out().file(name).text).toBe(`body of ${subject.toWellFormed()}`)
    },
  )

  test('the checker above does object to unsafe names', () => {
    // Guards the guard: each of these must be caught, or the test above proves nothing.
    const bad = ['a/b', 'a\\b', 'CON', 'nul.txt', ' x', 'x.', '.x', 'x\u202Ey', 'x\n', '', 'x'.repeat(73), '\uD800']
    bad.push('CLOCK$', 'conin$', 'CONOUT$.txt', 'COM\u00b9.txt', 'CON .txt', 'lpt0', 'x\uFFFE', 'x\uFDD0y', 'x\u{1FFFF}')
    bad.push('GIT~1', 'a~1.eml', 'PROGRA~1.EXE')
    for (const name of bad) expect(problemsWith(name), JSON.stringify(name)).not.toEqual([])
    const fine = ['2024-03-12 1015 Quarterly zebra report.eml', 'GIT_1.eml', 'a long name with a ~ in it.eml', 'Console.eml', 'COM10.eml']
    for (const name of fine) expect(problemsWith(name), name).toEqual([])
  })

  test('ordinary subjects are kept as written, in any script', async () => {
    const { save, out } = await setup()
    for (const subject of ['Quarterly zebra report', 'RE: Budget (final) [v2], 100% done!', 'Réunion à 15h', '日本語の件名', 'Привет мир']) {
      await save(subject)
    }
    expect(out().list()).toEqual([
      'Quarterly zebra report.eml',
      'RE_ Budget (final) [v2], 100% done!.eml',
      'Réunion à 15h.eml',
      '日本語の件名.eml',
      'Привет мир.eml',
    ])
  })

  test('a subject with nothing usable in it is called "message"', async () => {
    const { save, out } = await setup()
    await save('')
    await save('...')
    await save(' ~ . ')
    expect(out().list()).toEqual(['message.eml', 'message (2).eml', 'message (3).eml'])
  })

  test('characters that cannot be in a name are replaced, not dropped', async () => {
    const { save, out } = await setup()
    await save('a\u200Bb')
    await save('who? what*')
    expect(out().list()).toEqual(['a_b.eml', 'who_ what_.eml'])
  })

  test('the date goes first, in local time, so files sort by when they were sent', async () => {
    const { save, out } = await setup()
    await save('Later', new Date(2024, 2, 12, 15, 7).getTime())
    await save('Earlier', new Date(2001, 4, 4, 0, 0).getTime())
    await save('No date', null)
    await save('Bad date', Number.NaN)
    expect(out().list()).toEqual([
      '2024-03-12 1507 Later.eml',
      '2001-05-04 0000 Earlier.eml',
      'No date.eml',
      'Bad date.eml',
    ])
  })

  test('a long subject is cut, never inside a character, and still fits with its date', async () => {
    const { save, out } = await setup()
    await save('\u{1F600}'.repeat(100), new Date(2024, 0, 1, 9, 0).getTime())
    const [name] = out().list()
    expect(name.length).toBeLessThanOrEqual(72)
    expect(name.isWellFormed()).toBe(true)
    expect(name.startsWith('2024-01-01 0900 \u{1F600}')).toBe(true)
    expect(name.endsWith('\u{1F600}.eml')).toBe(true)
  })
})

describe('names that would collide', () => {
  test('messages with the same subject are numbered', async () => {
    const { save, out } = await setup()
    for (let i = 0; i < 4; i++) await save('Weekly update')
    expect(out().list()).toEqual([
      'Weekly update.eml',
      'Weekly update (2).eml',
      'Weekly update (3).eml',
      'Weekly update (4).eml',
    ])
  })

  test.each([
    ['only in case', 'Report', 'REPORT'],
    ['only in case, in Greek', 'ΑΣ', 'ασ'],
    ['only in how an accent is stored', 'caf\u00e9', 'cafe\u0301'],
    ['only by a compatibility form', 'ＡＢＣ', 'ABC'],
  ])('names that differ %s are treated as the same name', async (_what, first, second) => {
    // On a disk that tells them apart, so only the code's own care prevents a clash.
    const { save, out } = await setup({ caseInsensitive: false })
    await save(first)
    await save(second)
    const [a, b] = out().list()
    expect(a).toBe(`${first.normalize('NFC')}.eml`)
    expect(b).toBe(`${second.normalize('NFC')} (2).eml`)
  })

  test('a numbered name is still cut to fit', async () => {
    const { save, out } = await setup()
    const subject = 'y'.repeat(200)
    await save(subject)
    await save(subject)
    const [first, second] = out().list()
    expect(first.length).toBe(72)
    expect(second.length).toBe(72)
    expect(second.endsWith(' (2).eml')).toBe(true)
  })

  test('a name that could be taken for a Windows short name loses its tilde', async () => {
    const { save, out } = await setup()
    await save('GIT~1')
    expect(out().list()).toEqual(['GIT_1.eml'])
  })
})

describe('what is already on disk', () => {
  test('an existing file is never written over', async () => {
    const { fs, save, out, dir } = await setup()
    const existing = fs.root.dir(dir.nameOnDisk).seedFile('Weekly update.eml', 'the original')
    await save('Weekly update')
    expect(out().list()).toEqual(['Weekly update.eml', 'Weekly update (2).eml'])
    expect(existing.text).toBe('the original')
    expect(existing.commits).toBe(0)
  })

  test('nor is one the disk considers the same name', async () => {
    const { fs, save, out, dir } = await setup({ caseInsensitive: true })
    const existing = fs.root.dir(dir.nameOnDisk).seedFile('WEEKLY UPDATE.EML', 'the original')
    fs.root.dir(dir.nameOnDisk).seedDirectory('notes.eml')
    await save('Weekly update')
    await save('Notes')
    expect(out().list()).toEqual(['WEEKLY UPDATE.EML', 'notes.eml', 'Weekly update (2).eml', 'Notes (2).eml'])
    expect(existing.text).toBe('the original')
  })

  test('no file is ever written twice', async () => {
    const { save, out } = await setup({ caseInsensitive: true })
    const subjects = ['Same', 'same', 'SAME', 'Same.', ' Same', 'Other', 'other']
    for (const s of subjects) await save(s)
    const files = out().list().map((n) => out().file(n))
    expect(files).toHaveLength(subjects.length)
    expect(files.every((f) => f.commits === 1)).toBe(true)
  })

  test('an export gets a directory of its own, numbered if the name is taken', async () => {
    const fs = new MemoryFs()
    fs.root.seedDirectory('Enron')
    fs.root.seedFile('Enron (2)')
    const dir = await createFreshDirectory(fs.handle, 'Enron', 'Mailbox')
    expect(dir.nameOnDisk).toBe('Enron (3)')
    expect(fs.root.list()).toEqual(['Enron', 'Enron (2)', 'Enron (3)'])
  })

  test.each(HOSTILE.map((s) => [JSON.stringify(s).slice(0, 60), s]))(
    'an export directory named after %s is safe',
    async (_shown, label) => {
      const fs = new MemoryFs()
      const dir = await createFreshDirectory(fs.handle, label, 'Mailbox')
      expect(fs.root.list()).toEqual([dir.nameOnDisk])
      expect(problemsWith(dir.nameOnDisk), dir.nameOnDisk).toEqual([])
      // A directory has no dot at all: Chromium judges its "extension" too.
      expect(dir.nameOnDisk).not.toContain('.')
      expect(dir.nameOnDisk.length).toBeLessThanOrEqual(40)
    },
  )

  test('if the disk refuses the name, the export directory takes a plain one', async () => {
    const fs = new MemoryFs({ fail: (op, name) => op === 'createDirectory' && name.startsWith('Odd') && nameRefused() })
    const dir = await createFreshDirectory(fs.handle, 'Odd name', 'Mailbox')
    expect(dir.nameOnDisk).toBe('Mailbox')
  })

  test('a full disk is not mistaken for a refused name', async () => {
    const fs = new MemoryFs({ fail: (op) => op === 'createDirectory' && quotaExceeded() })
    await expect(createFreshDirectory(fs.handle, 'Export', 'Mailbox')).rejects.toThrow('The disk is full.')
  })
})

describe('folders', () => {
  test('a mail folder becomes a directory only once a message is saved in it', async () => {
    const { save, dir, out } = await setup()
    const inbox = dir.child('Inbox')
    const projects = inbox.child('Projects')
    dir.child('Empty folder')
    inbox.child('Also empty')
    expect(out().tree()).toEqual([])
    await save('Deep message', null, projects)
    expect(out().tree()).toEqual(['Inbox/', 'Inbox/Projects/', 'Inbox/Projects/Deep message.eml'])
    await save('Shallow message', null, inbox)
    expect(out().tree()).toEqual([
      'Inbox/',
      'Inbox/Projects/',
      'Inbox/Projects/Deep message.eml',
      'Inbox/Shallow message.eml',
    ])
  })

  test.each(HOSTILE.map((s) => [JSON.stringify(s).slice(0, 60), s]))(
    'a mail folder called %s becomes a safe directory',
    async (_shown, folderName) => {
      const { save, dir, out } = await setup()
      const child = dir.child(folderName)
      await save('Message', null, child)
      expect(problemsWith(child.nameOnDisk), child.nameOnDisk).toEqual([])
      expect(child.nameOnDisk).not.toContain('.')
      expect(out().tree()).toEqual([`${child.nameOnDisk}/`, `${child.nameOnDisk}/Message.eml`])
    },
  )

  test('folders with the same name, or names a disk would confuse, are numbered', async () => {
    const { save, dir, out } = await setup()
    const names = ['Archive', 'archive', 'Archive', 'Archive.', 'Arch/ive']
    const children = names.map((n) => dir.child(n))
    for (const [i, child] of children.entries()) await save(`m${i}`, null, child)
    expect(children.map((c) => c.nameOnDisk)).toEqual(['Archive', 'archive (2)', 'Archive (3)', 'Archive (4)', 'Arch_ive'])
    expect(out().tree().filter((p) => p.endsWith('.eml'))).toHaveLength(5)
  })

  test('a folder and a file of the same name do not clash', async () => {
    const { save, dir, out } = await setup()
    const child = dir.child('Budget.eml')
    await save('Budget')
    await save('Inside', null, child)
    expect(out().tree()).toEqual(['Budget.eml', 'Budget_eml/', 'Budget_eml/Inside.eml'])
  })

  test('a directory already on disk under the folder\'s name is not written into', async () => {
    const { fs, save, dir, out } = await setup()
    fs.root.dir(dir.nameOnDisk).seedDirectory('Inbox').seedFile('theirs.txt', 'keep')
    const inbox = dir.child('Inbox')
    await save('Mine', null, inbox)
    expect(inbox.nameOnDisk).toBe('Inbox (2)')
    expect(out().tree()).toEqual(['Inbox/', 'Inbox/theirs.txt', 'Inbox (2)/', 'Inbox (2)/Mine.eml'])
  })

  test('however deep and long-named the folders, the whole path stays short enough for Windows', async () => {
    const { fs, save, dir } = await setup({}, 'An export with quite a long name of its own')
    const levels = 8
    let current = dir
    const chain: ExportDirectory[] = []
    for (let depth = 0; depth < levels; depth++) {
      current = current.child(`Folder level ${depth} with a very long descriptive name indeed`, levels - 1 - depth)
      chain.push(current)
    }
    const subject = 'A subject that also goes on for rather a long time, well past any sensible length'
    for (const d of [dir, ...chain]) await save(subject, new Date(2024, 2, 12).getTime(), d)
    const paths = fs.root.tree().filter((p) => p.endsWith('.eml'))
    expect(paths).toHaveLength(levels + 1)
    for (const path of paths) {
      expect(path.length, path).toBeLessThanOrEqual(160)
      // Even squeezed, a name keeps enough of itself to be recognised.
      const parts = path.split('/')
      expect(parts.at(-1)!.length, path).toBeGreaterThanOrEqual(28)
      for (const part of parts.slice(0, -1)) expect(part.length, path).toBeGreaterThanOrEqual(10)
    }
  })
})

describe('writing messages', () => {
  test('a message arrives in pieces and is saved whole', async () => {
    const { writer, dir, out } = await setup()
    const dirOf = () => dir
    await writer.step({ kind: 'start', subject: 'Pieces', date: null, folderId: 'f' }, dirOf)
    for (const piece of ['From: a@example.com\r\n', '\r\n', 'first ', 'second']) {
      await writer.step({ kind: 'data', data: bytes(piece) }, dirOf)
    }
    // Until the message ends, nothing of it counts as exported.
    expect(writer.exported).toBe(0)
    expect(out().file('Pieces.eml').text).toBe('')
    await writer.step({ kind: 'end' }, dirOf)
    expect(writer.exported).toBe(1)
    expect(out().file('Pieces.eml').text).toBe('From: a@example.com\r\n\r\nfirst second')
  })

  test('a message that cannot be read is counted and leaves nothing behind', async () => {
    const { writer, dir, save, out } = await setup()
    const dirOf = () => dir
    await save('Good one')
    // Unreadable from the start.
    expect(await writer.step({ kind: 'skip' }, dirOf)).toBe(true)
    // Unreadable part way through: the half-written file must go.
    await writer.step({ kind: 'start', subject: 'Half', date: null, folderId: 'f' }, dirOf)
    await writer.step({ kind: 'data', data: bytes('partial') }, dirOf)
    expect(await writer.step({ kind: 'skip' }, dirOf)).toBe(true)
    await save('Another good one')
    expect(out().list()).toEqual(['Good one.eml', 'Another good one.eml'])
    expect([writer.exported, writer.unreadable, writer.unsaved]).toEqual([2, 2, 0])
  })

  test('a new message starting before the last one ended discards the unfinished one', async () => {
    const { writer, dir, out } = await setup()
    const dirOf = () => dir
    await writer.step({ kind: 'start', subject: 'Unfinished', date: null, folderId: 'f' }, dirOf)
    await writer.step({ kind: 'data', data: bytes('x') }, dirOf)
    await writer.step({ kind: 'start', subject: 'Finished', date: null, folderId: 'f' }, dirOf)
    await writer.step({ kind: 'end' }, dirOf)
    expect(out().list()).toEqual(['Finished.eml'])
    expect(writer.exported).toBe(1)
  })

  test('each message goes to the directory of its own folder', async () => {
    const { writer, dir, out } = await setup()
    const folders: Record<string, ExportDirectory> = { inbox: dir.child('Inbox'), sent: dir.child('Sent Items') }
    const dirOf = (id: string) => folders[id]
    for (const [folderId, subject] of [['inbox', 'One'], ['sent', 'Two'], ['inbox', 'Three']]) {
      await writer.step({ kind: 'start', subject, date: null, folderId }, dirOf)
      await writer.step({ kind: 'end' }, dirOf)
    }
    expect(out().tree()).toEqual(['Inbox/', 'Inbox/One.eml', 'Inbox/Three.eml', 'Sent Items/', 'Sent Items/Two.eml'])
  })

  test('cancelling stops at once and removes the file being written', async () => {
    const { writer, dir, save, cancel, out } = await setup()
    const dirOf = () => dir
    await save('Kept')
    await writer.step({ kind: 'start', subject: 'In progress', date: null, folderId: 'f' }, dirOf)
    await writer.step({ kind: 'data', data: bytes('partial') }, dirOf)
    cancel()
    expect(await writer.step({ kind: 'data', data: bytes('more') }, dirOf)).toBe(false)
    expect(await writer.step({ kind: 'end' }, dirOf)).toBe(false)
    expect(out().list()).toEqual(['Kept.eml'])
    expect(writer.exported).toBe(1)
    expect(writer.fatal).toBeNull()
  })
})

describe('when saving fails', () => {
  test('a file that fails while being written is removed, counted, and the export goes on', async () => {
    const { writer, save, out } = await setup({
      fail: (op, name) => op === 'write' && name.startsWith('Bad') && new Error('The device stopped responding.'),
    })
    expect(await save('Good')).toBe(true)
    expect(await save('Bad')).toBe(true)
    expect(await save('Good again')).toBe(true)
    expect(out().list()).toEqual(['Good.eml', 'Good again.eml'])
    expect([writer.exported, writer.unsaved, writer.unreadable]).toEqual([2, 1, 0])
    expect([...writer.reasons]).toEqual([['The device stopped responding.', 1]])
    expect(writer.fatal).toBeNull()
  })

  test('one that fails as it is closed is removed too', async () => {
    const { writer, save, out } = await setup({
      fail: (op, name) => op === 'close' && name.startsWith('Bad') && new Error('Could not finish the file.'),
    })
    await save('Bad')
    await save('Good')
    expect(out().list()).toEqual(['Good.eml'])
    expect([writer.exported, writer.unsaved]).toEqual([1, 1])
  })

  test('one that cannot be opened for writing does not leave an empty file', async () => {
    const { writer, save, out } = await setup({
      fail: (op, name) => op === 'openWritable' && name.includes('Locked') && new Error('The file is in use.'),
    })
    await save('Locked')
    // The second try, under a plain name, works.
    expect(out().list()).toEqual(['message.eml'])
    expect([writer.exported, writer.unsaved]).toEqual([1, 0])
  })

  test('a refused name is tried once more as "<date> message"', async () => {
    const { writer, save, out } = await setup({
      fail: (op, name) => op === 'createFile' && name.includes('Odd') && nameRefused(),
    })
    await save('Odd subject', new Date(2024, 2, 12, 10, 15).getTime())
    expect(out().list()).toEqual(['2024-03-12 1015 message.eml'])
    expect([writer.exported, writer.unsaved]).toEqual([1, 0])
  })

  test('a message whose name is refused both ways is counted as not saved, and its data is dropped quietly', async () => {
    const { writer, dir, save, out } = await setup({
      fail: (op, name) => op === 'createFile' && !name.startsWith('Fine') && nameRefused(),
    })
    const dirOf = () => dir
    expect(await writer.step({ kind: 'start', subject: 'Refused', date: null, folderId: 'f' }, dirOf)).toBe(true)
    expect(await writer.step({ kind: 'data', data: bytes('x') }, dirOf)).toBe(true)
    expect(await writer.step({ kind: 'end' }, dirOf)).toBe(true)
    expect(await save('Fine')).toBe(true)
    expect(out().list()).toEqual(['Fine.eml'])
    expect([writer.exported, writer.unsaved, writer.unreadable]).toEqual([1, 1, 0])
    expect([...writer.reasons]).toEqual([['Name is not allowed.', 1]])
  })

  test('a message that fails to save and then turns out unreadable is counted once', async () => {
    const { writer, dir } = await setup({ fail: (op) => op === 'createFile' && nameRefused() })
    const dirOf = () => dir
    await writer.step({ kind: 'start', subject: 'Both', date: null, folderId: 'f' }, dirOf)
    await writer.step({ kind: 'skip' }, dirOf)
    expect([writer.exported, writer.unsaved, writer.unreadable]).toEqual([0, 1, 0])
  })

  test.each([
    ['a full disk', quotaExceeded, 'The disk is full.'],
    ['lost permission', notAllowed, 'Permission was withdrawn.'],
    ['a security error', () => new DOMException('Blocked.', 'SecurityError'), 'Blocked.'],
  ])('%s stops the export, and nothing half-written is left', async (_what, error, message) => {
    let failing = false
    const { writer, dir, save, out } = await setup({ fail: (op) => failing && op === 'write' && error() })
    await save('Before')
    failing = true
    expect(await save('During')).toBe(false)
    expect(writer.fatal).toBe(message)
    expect(out().list()).toEqual(['Before.eml'])
    // Once stopped, it stays stopped.
    failing = false
    expect(await writer.step({ kind: 'start', subject: 'After', date: null, folderId: 'f' }, () => dir)).toBe(false)
    expect(out().list()).toEqual(['Before.eml'])
    expect(writer.exported).toBe(1)
  })

  test('twenty failures in a row, in a folder that was working, stop the export', async () => {
    let failing = false
    const { writer, save } = await setup({ fail: (op) => failing && op === 'write' && new Error('I/O error.') })
    await save('Works')
    failing = true
    const results: boolean[] = []
    for (let i = 0; i < 20; i++) results.push(await save(`Fails ${i}`))
    expect(results.slice(0, 19).every(Boolean)).toBe(true)
    expect(results[19]).toBe(false)
    expect(writer.fatal).toBe('20 files in a row could not be saved (I/O error)')
    expect(writer.unsaved).toBe(20)
    expect([...writer.reasons]).toEqual([['I/O error.', 20]])
  })

  test('a success in between starts the count again', async () => {
    let failing = false
    const { writer, save } = await setup({ fail: (op) => failing && op === 'write' && new Error('I/O error.') })
    await save('Works')
    for (let round = 0; round < 3; round++) {
      failing = true
      for (let i = 0; i < 19; i++) expect(await save(`Fails ${round}.${i}`)).toBe(true)
      failing = false
      expect(await save(`Works ${round}`)).toBe(true)
    }
    expect(writer.fatal).toBeNull()
    expect([writer.exported, writer.unsaved]).toEqual([4, 57])
  })

  test('a folder that never takes a file does not stop the export, however many messages it holds', async () => {
    const { writer, dir, save, out } = await setup({
      // Every directory below the export's own, whatever it is called.
      fail: (op, _name, path) => op === 'createDirectory' && path.includes('/') && new Error('Path too long.'),
    })
    const cursed = dir.child('Cursed')
    for (let i = 0; i < 50; i++) expect(await save(`In cursed ${i}`, null, cursed)).toBe(true)
    expect(await save('Elsewhere')).toBe(true)
    expect(writer.fatal).toBeNull()
    expect([writer.exported, writer.unsaved]).toEqual([1, 50])
    expect([...writer.reasons]).toEqual([['A folder could not be created: Path too long.', 50]])
    expect(out().tree()).toEqual(['Elsewhere.eml'])
  })

  test('a folder whose name is refused is created under a plain name instead', async () => {
    const { save, dir, out } = await setup({
      fail: (op, name) => op === 'createDirectory' && name.startsWith('Weird') && nameRefused(),
    })
    const weird = dir.child('Weird name')
    await save('Inside', null, weird)
    expect(weird.nameOnDisk).toBe('Folder')
    expect(out().tree()).toEqual(['Folder/', 'Folder/Inside.eml'])
  })

  test('a folder that could not be created is tried again for the next message', async () => {
    let failing = false
    const { writer, save, dir, out } = await setup({
      fail: (op) => failing && op === 'createDirectory' && quotaExceeded(),
    })
    const inbox = dir.child('Inbox')
    failing = true
    expect(await save('First', null, inbox)).toBe(false)
    expect(writer.fatal).toBe('The disk is full.')
    failing = false
    // A new writer (a new export) over the same directory object can go on.
    const again = new EmlTreeWriter(() => false)
    await again.step({ kind: 'start', subject: 'Second', date: null, folderId: 'f' }, () => inbox)
    await again.step({ kind: 'end' }, () => inbox)
    expect(out().tree()).toEqual(['Inbox/', 'Inbox/Second.eml'])
  })
})

describe('describeError', () => {
  test('gives words for anything thrown', () => {
    expect(describeError(new Error('Plain message.'))).toBe('Plain message.')
    expect(describeError(new DOMException('', 'NotFoundError'))).toBe('NotFoundError')
    expect(describeError('a string')).toBe('a string')
    expect(describeError(undefined)).toBe('undefined')
  })
})

describe('choosing the folder', () => {
  test('exporting needs a browser that can write to a folder', () => {
    vi.stubGlobal('window', {})
    expect(canExportToFolder()).toBe(false)
    vi.stubGlobal('window', { showDirectoryPicker: async () => ({}) })
    expect(canExportToFolder()).toBe(true)
  })

  test('the picker is asked for a folder it may write to', async () => {
    const handle = new MemoryFs().handle
    const show = vi.fn(async () => handle)
    vi.stubGlobal('window', { showDirectoryPicker: show })
    expect(await pickExportFolder()).toBe(handle)
    expect(show).toHaveBeenCalledWith({ id: 'pstviewer-export', mode: 'readwrite', startIn: 'documents' })
  })

  test('closing the picker is not an error', async () => {
    vi.stubGlobal('window', {
      showDirectoryPicker: async () => {
        throw new DOMException('The user aborted a request.', 'AbortError')
      },
    })
    expect(await pickExportFolder()).toBeNull()
  })

  test('any other failure of the picker is reported', async () => {
    vi.stubGlobal('window', {
      showDirectoryPicker: async () => {
        throw new DOMException('Not allowed here.', 'SecurityError')
      },
    })
    await expect(pickExportFolder()).rejects.toThrow('Not allowed here.')
    vi.stubGlobal('window', {})
    expect(await pickExportFolder()).toBeNull()
  })
})
