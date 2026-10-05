import { describe, expect, test } from 'vitest'
import { selectMailboxTree } from '../../src/worker/pst.worker'
import type { FolderNode } from '../../src/types'

let nextId = 1
const folder = (name: string, messageCount = 0, children: FolderNode[] = []): FolderNode => ({
  id: String(nextId++),
  name,
  containerClass: '',
  messageCount,
  children,
})

const all = (node: FolderNode): FolderNode[] => [node, ...node.children.flatMap(all)]
const total = (node: FolderNode) => all(node).reduce((n, f) => n + f.messageCount, 0)
/** What the sidebar lists: everything under the root, as "name (count)" paths. */
const rows = (tree: FolderNode, prefix = ''): string[] =>
  tree.children.flatMap((c) => [`${prefix}${c.name} (${c.messageCount})`, ...rows(c, `${prefix}${c.name}/`)])

describe('selectMailboxTree', () => {
  test('a .pst shows the folders under "Top of Personal Folders", not the plumbing around them', () => {
    const top = folder('Top of Personal Folders', 0, [
      folder('Inbox', 5, [folder('Projects', 2)]),
      folder('Sent Items', 3),
      folder('Deleted Items', 0),
    ])
    const root = folder('', 0, [folder('SPAM Search Folder 2', 0), top, folder('Search Root', 0)])
    const { tree, ownerHint, ownMail } = selectMailboxTree(root, top.id)
    expect(rows(tree)).toEqual(['Inbox (5)', 'Inbox/Projects (2)', 'Sent Items (3)', 'Deleted Items (0)'])
    expect(ownerHint).toBe('Top of Personal Folders')
    expect(ownMail).toBeNull()
  })

  test('an .ost is recognised by its IPM_SUBTREE even when the library points elsewhere', () => {
    const subtree = folder('IPM_SUBTREE', 0, [folder('Inbox', 40), folder('Calendar', 4)])
    const wrong = folder('Some Mail Folder', 1)
    const root = folder('Root - Mailbox', 0, [folder('Common Views', 0), subtree, folder('Finder', 0), wrong])
    const { tree } = selectMailboxTree(root, wrong.id)
    // The stray folder holds mail too, so it is kept beside the real ones.
    expect(rows(tree)).toEqual(['Inbox (40)', 'Calendar (4)', 'Some Mail Folder (1)'])
  })

  test('sibling folders that hold mail are kept, empty ones dropped', () => {
    const top = folder('IPM_SUBTREE', 0, [folder('Inbox', 10)])
    const root = folder('Root', 0, [
      top,
      folder('Recoverable Items', 0, [folder('Deletions', 3)]),
      folder('Empty Plumbing', 0, [folder('Nothing', 0)]),
    ])
    const { tree } = selectMailboxTree(root, null)
    expect(rows(tree)).toEqual(['Inbox (10)', 'Recoverable Items (0)', 'Recoverable Items/Deletions (3)'])
  })

  test('mail kept directly in the chosen top folder gets a row of its own', () => {
    const top = folder('Top of Outlook data file', 1, [folder('Inbox', 2)])
    const root = folder('', 0, [top])
    const { tree, ownMail } = selectMailboxTree(root, top.id)
    expect(rows(tree)).toEqual(['Top of Outlook data file (1)', 'Inbox (2)'])
    // The row reads the real folder, so it carries that folder's id.
    expect(ownMail?.id).toBe(top.id)
    expect(tree.children[0]).toBe(ownMail)
    expect(ownMail?.children).toEqual([])
  })

  test('a top folder with a name that means nothing to a reader is called "Top of mailbox"', () => {
    for (const name of ['IPM_SUBTREE', 'ipm_subtree', '', '(unnamed folder)', '  ']) {
      const top = folder(name, 4, [folder('Inbox', 1)])
      const { tree } = selectMailboxTree(folder('Root', 0, [top]), top.id)
      expect(rows(tree)[0], JSON.stringify(name)).toBe('Top of mailbox (4)')
    }
  })

  test('if the tidy view would hide mail, the whole tree is shown instead', () => {
    const top = folder('IPM_SUBTREE', 0, [folder('Inbox', 10)])
    const root = folder('Root', 0, [top, folder('Elsewhere', 0, [folder('Hidden', 2)])])
    // "Elsewhere" is a sibling with mail, so it is rescued and nothing is hidden.
    expect(total(selectMailboxTree(root, null).tree)).toBe(12)

    // Mail in the root itself cannot be rescued by pruning: show everything.
    const rootWithMail = folder('Root', 3, [folder('IPM_SUBTREE', 0, [folder('Inbox', 10)]), folder('Views', 0)])
    const { tree, ownMail } = selectMailboxTree(rootWithMail, null)
    expect(rows(tree)).toEqual(['Root (3)', 'IPM_SUBTREE (0)', 'IPM_SUBTREE/Inbox (10)', 'Views (0)'])
    expect(ownMail?.id).toBe(rootWithMail.id)
    expect(tree.id).not.toBe(rootWithMail.id)
  })

  test('with nothing to go on, the tree is shown as it is', () => {
    const root = folder('Root', 0, [folder('A', 1), folder('B', 2)])
    const { tree, ownerHint, ownMail } = selectMailboxTree(root, null)
    expect(tree).toBe(root)
    expect(ownerHint).toBe('')
    expect(ownMail).toBeNull()
  })

  test('an empty mailbox is shown as it is', () => {
    const top = folder('IPM_SUBTREE', 0, [folder('Inbox', 0)])
    const root = folder('Root', 0, [top])
    expect(selectMailboxTree(root, top.id).tree).toBe(root)
  })

  // The rules that must hold for any mailbox at all, checked on a few thousand
  // random ones: no message is ever hidden, and no two rows share an id.
  test('whatever the shape of the mailbox, every message stays reachable under a unique id', () => {
    let seed = 20240312
    const random = (max: number) => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
      return seed % max
    }
    const names = ['Inbox', 'IPM_SUBTREE', '', 'Sent', 'Top of Personal Folders', '(unnamed folder)', 'Archive']
    const build = (depth: number): FolderNode =>
      folder(
        names[random(names.length)],
        random(3) === 0 ? random(20) : 0,
        depth >= 4 ? [] : Array.from({ length: random(4) }, () => build(depth + 1)),
      )

    for (let i = 0; i < 3000; i++) {
      const root = build(0)
      const everything = all(root)
      const libraryTop = random(3) === 0 ? null : everything[random(everything.length)].id
      const { tree, ownMail } = selectMailboxTree(root, libraryTop)

      const shown = all(tree).slice(1) // the root itself is never a row
      const label = `mailbox ${i}`
      expect(shown.reduce((n, f) => n + f.messageCount, 0), label).toBe(total(root))
      expect(new Set(all(tree).map((f) => f.id)).size, label).toBe(all(tree).length)
      // Every row that holds mail reads a folder that really exists, by its own id.
      const real = new Map(everything.map((f) => [f.id, f]))
      for (const row of shown.filter((r) => r.messageCount > 0)) {
        expect(real.get(row.id)?.messageCount, label).toBe(row.messageCount)
      }
      expect(ownMail === null || shown.includes(ownMail), label).toBe(true)
      // The input is never modified.
      expect(total(root), label).toBe(everything.reduce((n, f) => n + f.messageCount, 0))
    }
  })
})
