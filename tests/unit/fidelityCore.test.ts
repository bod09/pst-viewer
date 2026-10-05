import { describe, expect, test } from 'vitest'
import { diff, folderPaths, FORMAT, redact, sha, unusable } from '../../scripts/lib/fidelity.mjs'
import type { FolderNode } from '../../src/types'

type Snapshot = Parameters<typeof redact>[0]
type Row = Snapshot['folders'][number]['rows'][number]

const row = (id: string, overrides: Partial<Row> = {}): Row => ({
  id,
  subject: `Subject ${id}`,
  from: 'Alice Example <alice@example.com>',
  to: 'Bob Tester',
  date: 1_700_000_000_000,
  att: false,
  cls: 'IPM.Note',
  body: sha(`body ${id}`),
  atts: '',
  ...overrides,
})

const snapshot = (folders: [path: string[], rows: Row[], extra?: { nth?: number; unreadable?: number }][]): Snapshot => ({
  format: FORMAT,
  file: 'box.pst',
  full: true,
  redacted: false,
  messages: folders.reduce((n, [, rows]) => n + rows.length, 0),
  bodies: folders.reduce((n, [, rows]) => n + rows.length, 0),
  folders: folders.map(([path, rows, extra]) => ({ path, nth: extra?.nth ?? 0, unreadable: extra?.unreadable ?? 0, rows })),
})

const base = () =>
  snapshot([
    [[], []],
    [['Inbox'], [row('1'), row('2'), row('3')]],
    [['Inbox', 'Projects'], [row('4')]],
    [['Sent Items'], [row('5')]],
  ])

const folder = (name: string, children: FolderNode[] = []): FolderNode => ({
  id: name || 'root',
  name,
  containerClass: '',
  messageCount: 0,
  children,
})

describe('folderPaths', () => {
  test('lists the root first, then every folder by the names leading to it', () => {
    const tree = folder('', [folder('Inbox', [folder('Projects')]), folder('Sent Items')])
    expect(folderPaths(tree).map((f) => f.path)).toEqual([[], ['Inbox'], ['Inbox', 'Projects'], ['Sent Items']])
  })

  test('folders that share a path are told apart by position among them', () => {
    const tree = folder('', [folder('Archive'), folder('Archive'), folder('Other'), folder('Archive')])
    expect(folderPaths(tree).map((f) => [f.path.join('/'), f.nth])).toEqual([
      ['', 0],
      ['Archive', 0],
      ['Archive', 1],
      ['Other', 0],
      ['Archive', 2],
    ])
  })

  test('a slash in a name is not mistaken for a level', () => {
    const tree = folder('', [folder('A/B'), folder('A', [folder('B')])])
    const paths = folderPaths(tree).map((f) => JSON.stringify(f.path))
    expect(new Set(paths).size).toBe(paths.length)
  })

  test('a prefix puts a whole mailbox under one name', () => {
    expect(folderPaths(folder('', [folder('Inbox')]), ['box.pst']).map((f) => f.path)).toEqual([
      ['box.pst'],
      ['box.pst', 'Inbox'],
    ])
  })
})

describe('diff', () => {
  test('identical snapshots have no differences', () => {
    expect(diff(base(), base())).toEqual([])
  })

  test.each<[string, (s: Snapshot) => void, string]>([
    ['a changed subject', (s) => (s.folders[1].rows[1].subject = 'Other'), 'Inbox[1] subject: "Subject 2" -> "Other"'],
    ['a changed sender', (s) => (s.folders[1].rows[0].from = 'Eve <eve@example.com>'), 'Inbox[0] from: "Alice Example <alice@example.com>" -> "Eve <eve@example.com>"'],
    ['a changed date', (s) => (s.folders[3].rows[0].date = null), 'Sent Items[0] date: 1700000000000 -> null'],
    ['a changed body', (s) => (s.folders[2].rows[0].body = sha('different')), `Inbox > Projects[0] body: "${sha('body 4')}" -> "${sha('different')}"`],
    ['a changed attachment list', (s) => (s.folders[1].rows[2].atts = 'a.pdf'), 'Inbox[2] atts: "" -> "a.pdf"'],
    ['a field that stopped being recorded', (s) => delete s.folders[1].rows[0].body, `Inbox[0] body: "${sha('body 1')}" -> undefined`],
    ['a message id that changed', (s) => (s.folders[1].rows[0].id = '99'), 'Inbox[0] id: "1" -> "99"'],
    ['an unreadable message', (s) => (s.folders[1].unreadable = 2), 'Inbox: 0 unreadable in baseline, 2 now'],
  ])('reports %s', (_what, change, expected) => {
    const current = base()
    change(current)
    expect(diff(base(), current)).toEqual([expected])
  })

  test('reports messages in a different order, which counts would never show', () => {
    const current = base()
    current.folders[1].rows.reverse()
    const problems = diff(base(), current)
    expect(problems).toEqual(['Inbox[0] id: "1" -> "3"', 'Inbox[2] id: "3" -> "1"'])
  })

  test('reports a lost message once as a count, and each row that shifted', () => {
    const current = base()
    current.folders[1].rows.splice(0, 1)
    current.messages--
    expect(diff(base(), current)).toEqual([
      'message count: baseline 5, now 4',
      'Inbox: 3 messages in baseline, 2 now',
      'Inbox[0] id: "1" -> "2"',
      'Inbox[1] id: "2" -> "3"',
    ])
  })

  test('a folder that appears is reported as that folder, and the others still line up', () => {
    const current = snapshot([
      [[], []],
      [['Top of mailbox'], [row('9')]],
      [['Inbox'], [row('1'), row('2'), row('3')]],
      [['Inbox', 'Projects'], [row('4')]],
      [['Sent Items'], [row('5')]],
    ])
    expect(diff(base(), current)).toEqual([
      'message count: baseline 5, now 6',
      'new folder: Top of mailbox (1 messages)',
    ])
  })

  test('a folder that disappears is reported with what it held', () => {
    const current = base()
    current.folders.splice(2, 1)
    current.messages--
    expect(diff(base(), current)).toEqual(['message count: baseline 5, now 4', 'folder gone: Inbox > Projects'])
  })

  test('folders in a different order are not a difference in what is read', () => {
    const current = base()
    current.folders.reverse()
    expect(diff(base(), current)).toEqual([])
  })

  test('two folders with the same path are compared each with its own', () => {
    const twins = () =>
      snapshot([
        [['Archive'], [row('1')], { nth: 0 }],
        [['Archive'], [row('2')], { nth: 1 }],
      ])
    const current = twins()
    current.folders[1].rows[0].subject = 'Changed'
    expect(diff(twins(), current)).toEqual(['Archive #2[0] subject: "Subject 2" -> "Changed"'])
  })

  test('a long list of differences is cut short', () => {
    const many = (suffix: string) => snapshot([[['Inbox'], Array.from({ length: 200 }, (_, i) => row(String(i), { subject: `${i}${suffix}` }))]])
    expect(diff(many('a'), many('b'))).toHaveLength(30)
  })
})

describe('redact', () => {
  test('replaces every piece of text from the mailbox with a hash of it', () => {
    const plain = snapshot([[['Inbox', 'Secret Project'], [row('1', { subject: 'Confidential', atts: 'plan.pdf' })]]])
    const hidden = redact(plain)
    const text = JSON.stringify(hidden)
    for (const secret of ['Inbox', 'Secret Project', 'Confidential', 'alice@example.com', 'Alice', 'Bob Tester', 'plan.pdf']) {
      expect(text).not.toContain(secret)
    }
    expect(hidden.redacted).toBe(true)
    // What is not text stays, so the baseline still pins it down.
    expect(hidden.folders[0].rows[0]).toMatchObject({ id: '1', date: 1_700_000_000_000, att: false, cls: 'IPM.Note', body: sha('body 1') })
    // The original is left as it was, and redacting twice changes nothing more.
    expect(plain.folders[0].rows[0].subject).toBe('Confidential')
    expect(redact(hidden)).toBe(hidden)
  })

  test('a redacted baseline still catches every kind of change', () => {
    const baseline = redact(base())
    const changes: [(s: Snapshot) => void, string][] = [
      [(s) => (s.folders[1].rows[1].subject = 'Other'), 'Inbox[1] subject: differs from the baseline, now "Other"'],
      [(s) => (s.folders[1].rows[0].to = 'Eve'), 'Inbox[0] to: differs from the baseline, now "Eve"'],
      [(s) => (s.folders[1].rows[2].atts = 'a.pdf'), 'Inbox[2] atts: differs from the baseline, now "a.pdf"'],
      // Values that were never text are shown as they are.
      [(s) => (s.folders[3].rows[0].date = 5), 'Sent Items[0] date: 1700000000000 -> 5'],
      [(s) => (s.folders[1].rows[0].body = sha('x')), `Inbox[0] body: "${sha('body 1')}" -> "${sha('x')}"`],
    ]
    for (const [change, expected] of changes) {
      const plain = base()
      change(plain)
      expect(diff(baseline, redact(plain), plain)).toEqual([expected])
    }
    expect(diff(baseline, redact(base()), base())).toEqual([])
  })

  test('a renamed folder shows up by the name it has now', () => {
    const plain = base()
    plain.folders[3].path = ['Sent']
    expect(diff(redact(base()), redact(plain), plain)).toEqual([
      'new folder: Sent (1 messages)',
      'folder gone: a folder that held 1 messages (its name is hashed in the baseline)',
    ])
  })
})

describe('unusable', () => {
  test('accepts a baseline of the current format', () => {
    expect(unusable(base())).toBeNull()
    expect(unusable(redact(base()))).toBeNull()
  })

  test.each([
    ['nothing', null, 'it is not a baseline'],
    ['something else entirely', 'text', 'it is not a baseline'],
    ['one from before formats were numbered', { file: 'x', full: true, folders: [] }, 'it was written by an older version of this check'],
    ['one of another format', { ...base(), format: FORMAT + 1 }, 'it was written by an older version of this check'],
    ['one with parts missing', { format: FORMAT, full: true, redacted: false }, 'it is incomplete'],
  ])('refuses %s', (_what, value, reason) => {
    expect(unusable(value)).toBe(reason)
  })
})
