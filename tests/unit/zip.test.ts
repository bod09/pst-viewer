import { describe, expect, test } from 'vitest'
import { scanZipForPsts } from '../../src/lib/zip'
import { mailEml, mailMsg, zip } from '../support/fixtures.mjs'

const bytes = (s: string) => new TextEncoder().encode(s)
const zipFile = (entries: Record<string, Uint8Array>, lastModified = 1_700_000_000_000) =>
  new File([zip(entries) as Uint8Array<ArrayBuffer>], 'archive.zip', { lastModified })

describe('scanZipForPsts', () => {
  test('finds mailboxes and messages at any depth, and names what else was there', async () => {
    const result = await scanZipForPsts(
      zipFile({
        'top.pst': bytes('pst bytes'),
        'deep/er/folder/Archive.OST': bytes('ost bytes'),
        'mail/one.eml': mailEml(),
        'mail/two.MSG': mailMsg(),
        'docs/readme.txt': bytes('hello'),
        'photo.jpg': bytes('jpeg'),
      }),
    )
    expect(result.psts.map((p) => [p.name, p.path])).toEqual([
      ['top.pst', 'top.pst'],
      ['Archive.OST', 'deep/er/folder/Archive.OST'],
    ])
    expect(result.msgs.map((m) => m.name)).toEqual(['one.eml', 'two.MSG'])
    expect(result.otherFiles.sort()).toEqual(['photo.jpg', 'readme.txt'])
    expect(new Uint8Array(await result.msgs[0].file.arrayBuffer())).toEqual(mailEml())
  })

  test('looks inside zips within zips', async () => {
    const inner = zip({ 'inner.pst': bytes('inner pst'), 'note.txt': bytes('x') })
    const middle = zip({ 'nested/inner.zip': inner, 'middle.eml': mailEml() })
    const result = await scanZipForPsts(zipFile({ 'outer.zip': middle }))
    expect(result.psts.map((p) => p.name)).toEqual(['inner.pst'])
    expect(result.msgs.map((m) => m.name)).toEqual(['middle.eml'])
    expect(result.otherFiles).toEqual(['note.txt'])
  })

  test('stops descending after four levels of nesting', async () => {
    // level 0 is the file itself; a mailbox at level 4 is found, at level 5 it is not.
    let at4: Uint8Array = zip({ 'four.pst': bytes('level four') })
    for (let i = 0; i < 4; i++) at4 = zip({ 'next.zip': at4 })
    expect((await scanZipForPsts(zipFile({ 'a.zip': at4 }))).psts).toEqual([])
    expect((await scanZipForPsts(new File([at4 as Uint8Array<ArrayBuffer>], 'x.zip'))).psts.map((p) => p.name)).toEqual([
      'four.pst',
    ])
  })

  test('ignores folders, hidden files, macOS leftovers and empty entries', async () => {
    const result = await scanZipForPsts(
      zipFile({
        '__MACOSX/._real.pst': bytes('resource fork'),
        '.hidden.pst': bytes('hidden'),
        'dir/.DS_Store': bytes('x'),
        'empty.pst': new Uint8Array(0),
        'real.pst': bytes('real'),
      }),
    )
    expect(result.psts.map((p) => p.name)).toEqual(['real.pst'])
    expect(result.otherFiles).toEqual([])
  })

  test('files keep the time of the zip they came from, so they are recognised next time', async () => {
    const result = await scanZipForPsts(zipFile({ 'a.pst': bytes('a'), 'b.eml': mailEml() }, 1_234_567_890_000))
    expect(result.psts[0].file.lastModified).toBe(1_234_567_890_000)
    expect(result.msgs[0].file.lastModified).toBe(1_234_567_890_000)
  })

  test('lists at most fifty other files', async () => {
    const entries: Record<string, Uint8Array> = {}
    for (let i = 0; i < 80; i++) entries[`file${i}.txt`] = bytes('x')
    expect((await scanZipForPsts(zipFile(entries))).otherFiles).toHaveLength(50)
  })

  test('something that is not a zip is an error, not an empty result', async () => {
    await expect(scanZipForPsts(new File(['definitely not a zip'], 'fake.zip'))).rejects.toThrow('invalid zip data')
  })
})
