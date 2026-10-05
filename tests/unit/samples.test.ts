import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'vitest'
import { fixtureFiles } from '../support/fixtures.mjs'
import { publicFilePath, publicMailbox, sampleFileNames } from '../support/mailboxes'

/**
 * samples/ is the one place mail files are committed, so what is in it is
 * pinned down here: every file is either built by this repository's own
 * fixture code, or is a listed public test file with a recorded hash. Anything
 * else in the folder fails a test, so nothing can be dropped in by accident.
 */
const SAMPLES = fileURLToPath(new URL('../../samples/', import.meta.url))

/** Every file under samples/, as paths relative to it. */
function files(dir: string, prefix = ''): string[] {
  return readdirSync(dir).flatMap((name) =>
    statSync(`${dir}/${name}`).isDirectory() ? files(`${dir}/${name}`, `${prefix}${name}/`) : [`${prefix}${name}`],
  )
}

describe('samples/', () => {
  test('holds only the files it is meant to', () => {
    const made = Object.keys(fixtureFiles()).map((name) => `made-up/${name}`)
    const listed = sampleFileNames.map((name) => publicFilePath(name).slice(SAMPLES.length))
    // And the license each borrowed set came under, as those licenses ask.
    const notes = ['README.md', 'msgreader/LICENSE', 'pst-extractor/LICENSE']
    expect(files(SAMPLES).sort()).toEqual([...notes, ...made, ...listed].sort())
  })

  test.each(Object.entries(fixtureFiles()))('made-up/%s is exactly what the fixture code builds', (name, bytes) => {
    // If this fails after a change to tests/support/fixtures.mjs: npm run fixtures -- samples/made-up
    const onDisk = readFileSync(`${SAMPLES}made-up/${name}`)
    expect(createHash('sha256').update(onDisk).digest('hex')).toBe(createHash('sha256').update(bytes).digest('hex'))
  })

  test.each(sampleFileNames)('%s is the file recorded in the manifest', (name) => {
    expect(publicFilePath(name).startsWith(SAMPLES)).toBe(true)
    // publicMailbox checks the SHA-256 and throws if it differs.
    expect(publicMailbox(name).size).toBeGreaterThan(0)
  })

  test('the files with real people\'s mail in them are not samples', () => {
    for (const name of ['enron.pst', 'mtnman1965@outlook.com.ost', 'pstextractortest@outlook.com.ost', 'A schedule.msg']) {
      expect(sampleFileNames, name).not.toContain(name)
      expect(publicFilePath(name)).toContain('/fixtures/public/')
    }
  })
})
