/**
 * Download the public test mailboxes the tests read real .pst and .ost files
 * from (see tests/public-mailboxes.json).
 *
 * They come from the pst-extractor project's own test data. Each is pinned to
 * an exact commit and checked against a SHA-256, so what the tests read is
 * exactly what was reviewed, whatever happens to that repository later. They
 * go to fixtures/public/, which is git-ignored: nothing here ends up in a
 * commit.
 *
 *   node scripts/fetch-mailboxes.mjs           # download what is missing
 *   node scripts/fetch-mailboxes.mjs --check   # only verify; never touch the network
 *
 * This is the one place in the repository that makes a network request, and
 * it runs only when you run it (or in CI). The app itself never does.
 */
import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const DIR = join(ROOT, 'fixtures/public')
const checkOnly = process.argv.includes('--check')

/** @type {{ files: { name: string, bytes: number, sha256: string, urls: string[] }[] }} */
const manifest = JSON.parse(await readFile(join(ROOT, 'tests/public-mailboxes.json'), 'utf8'))

/** @param {Uint8Array} bytes */
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')

/** Whether the file is already here and is the right one. */
async function present(/** @type {(typeof manifest.files)[number]} */ entry) {
  try {
    return sha256(await readFile(join(DIR, entry.name))) === entry.sha256
  } catch {
    return false
  }
}

/** Fetch one URL fully, giving up if the server stalls. */
async function download(/** @type {string} */ url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(120_000), redirect: 'follow' })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  return new Uint8Array(await response.arrayBuffer())
}

await mkdir(DIR, { recursive: true })
let failed = 0
for (const entry of manifest.files) {
  if (await present(entry)) {
    console.log(`ok       ${entry.name}`)
    continue
  }
  if (checkOnly) {
    console.error(`missing  ${entry.name}`)
    failed++
    continue
  }
  let saved = false
  for (const url of entry.urls) {
    try {
      const bytes = await download(url)
      // The hash is the whole point: a file that is not byte for byte the one
      // that was reviewed is not kept, whoever served it.
      if (bytes.length !== entry.bytes || sha256(bytes) !== entry.sha256) {
        throw new Error(`not the expected file (${bytes.length} bytes, sha256 ${sha256(bytes).slice(0, 12)}…)`)
      }
      // Written under another name first, so a download cut short never
      // leaves a file that looks complete.
      const partial = join(DIR, `${entry.name}.partial`)
      await writeFile(partial, bytes)
      await rename(partial, join(DIR, entry.name))
      console.log(`fetched  ${entry.name} (${(bytes.length / 1024 / 1024).toFixed(1)} MB)`)
      saved = true
      break
    } catch (err) {
      console.error(`  ${new URL(url).host}: ${err instanceof Error ? err.message : err}`)
      await rm(join(DIR, `${entry.name}.partial`), { force: true })
    }
  }
  if (!saved) {
    console.error(`FAILED   ${entry.name}`)
    failed++
  }
}

if (failed) {
  console.error(
    checkOnly
      ? `\n${failed} of ${manifest.files.length} public test files are missing or changed. Run: npm run mailboxes`
      : `\n${failed} of ${manifest.files.length} public test files could not be fetched.`,
  )
  process.exit(1)
}
console.log(`\nall ${manifest.files.length} public test files are in ${DIR}`)
