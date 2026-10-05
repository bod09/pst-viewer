/**
 * Write small synthetic .msg / .eml / .zip files for testing by hand.
 *
 * The fidelity check needs mail to run against, and real mail cannot go in the
 * repository. These are made up (see tests/support/fixtures.mjs, which the
 * automated tests build the same files from). They are written to the path
 * you give (default ./fixtures), which is git-ignored.
 *
 *   node scripts/make-fixtures.mjs [outputDir]
 *   node scripts/fidelity.mjs fixtures/mail.eml --update --full
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { fixtureFiles } from '../tests/support/fixtures.mjs'

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const outDir = resolve(process.argv[2] ?? join(ROOT, 'fixtures'))
await mkdir(outDir, { recursive: true })

const files = fixtureFiles()
for (const [name, bytes] of Object.entries(files)) await writeFile(join(outDir, name), bytes)

console.log(`wrote ${Object.keys(files).join(', ')} to ${outDir}`)
