/**
 * Re-record the fidelity baselines kept in the repository (tests/baselines/).
 *
 * Run this only when a change is meant to alter what the worker reads, look at
 * the diff it produces, and say in the pull request why each difference is
 * right. If the baselines change and you did not expect them to, the code is
 * wrong, not the baselines.
 *
 *   node scripts/update-baselines.mjs
 *
 * Baselines of the made-up fixtures are stored as plain text, since there is
 * nothing private in them and a readable diff is worth having. Baselines of
 * the public test mailboxes are redacted (see redact() in lib/fidelity.mjs):
 * that mail is public, but none of it belongs in this repository.
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { fixtureFiles } from '../tests/support/fixtures.mjs'
import { loadWorker, redact, snapshotFile } from './lib/fidelity.mjs'

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const OUT = join(ROOT, 'tests/baselines')
const manifest = JSON.parse(await readFile(join(ROOT, 'tests/public-mailboxes.json'), 'utf8'))

const { api, scanZip } = await loadWorker()
await mkdir(OUT, { recursive: true })

/** @param {File} file @param {boolean} redacted */
async function record(file, redacted) {
  const plain = await snapshotFile(api, file, { full: true, scanZip })
  const snapshot = redacted ? redact(plain) : plain
  await writeFile(join(OUT, `${file.name}.json`), JSON.stringify(snapshot, null, 1) + '\n')
  console.log(`${file.name}: ${snapshot.messages} messages in ${snapshot.folders.length} folders${redacted ? ' (redacted)' : ''}`)
}

for (const [name, bytes] of Object.entries(fixtureFiles())) await record(new File([Buffer.from(bytes)], name), false)

for (const entry of manifest.files) {
  let bytes
  try {
    bytes = await readFile(join(ROOT, entry.sample ?? 'fixtures/public', entry.name))
  } catch {
    console.error(`\n${entry.name} is not here. Fetch the public test files first: npm run mailboxes`)
    process.exit(1)
  }
  await record(new File([bytes], entry.name), true)
}
