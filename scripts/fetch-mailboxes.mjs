/**
 * Download the public test files that are not kept in the repository, and
 * check the ones that are (see tests/public-mailboxes.json).
 *
 * All of them come from the test data of the pst-extractor and msgreader
 * projects, each pinned to an exact commit and checked against a SHA-256, so
 * what the tests read is exactly what was reviewed, whatever happens to those
 * repositories later. The synthetic ones live in samples/. The ones holding
 * real people's mail are downloaded to fixtures/public/, which is git-ignored:
 * nothing fetched here ends up in a commit.
 *
 *   node scripts/fetch-mailboxes.mjs           # download what is missing
 *   node scripts/fetch-mailboxes.mjs --check   # only verify; never touch the network
 *
 * This is the one place in the repository that makes a network request, and
 * it runs only when you run it (or in CI). The app itself never does.
 */
import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const DIR = join(ROOT, 'fixtures/public')
const ATTEMPTS = 3
/** Give up on a download that sends nothing for this long (not a limit on the whole download). */
const STALL_MS = 30_000

const args = process.argv.slice(2)
const unknown = args.filter((a) => a !== '--check')
if (unknown.length) {
  console.error(`unknown argument ${unknown[0]}\nusage: node scripts/fetch-mailboxes.mjs [--check]`)
  process.exit(2)
}
const checkOnly = args.includes('--check')

/** @typedef {{ name: string, bytes: number, sha256: string, urls: string[], sample?: string }} Entry */
/** @type {{ files: Entry[] }} */
const manifest = JSON.parse(await readFile(join(ROOT, 'tests/public-mailboxes.json'), 'utf8'))

// The manifest is data, and data gets less of a look in review than code does.
// A name is only ever a file name in fixtures/public, and a source only https.
for (const entry of manifest.files) {
  if (entry.name !== basename(entry.name) || entry.name.startsWith('.') || /[\\/]/.test(entry.name)) {
    console.error(`refusing the manifest: "${entry.name}" is not a plain file name`)
    process.exit(2)
  }
  if (!/^[0-9a-f]{64}$/.test(entry.sha256) || !entry.urls.length || !entry.urls.every((u) => u.startsWith('https://'))) {
    console.error(`refusing the manifest: "${entry.name}" needs a sha256 and https sources`)
    process.exit(2)
  }
  if (entry.sample !== undefined && !/^samples\/[\w-]+$/.test(entry.sample)) {
    console.error(`refusing the manifest: "${entry.name}" has a sample folder that is not under samples/`)
    process.exit(2)
  }
}

/** Where a file is kept: in the repository if it is a sample, otherwise in the download folder. */
const pathOf = (/** @type {Entry} */ entry) => join(entry.sample ? join(ROOT, entry.sample) : DIR, entry.name)

/** @param {Uint8Array} bytes */
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')

/**
 * Whether the file is here and is the right one.
 *
 * @param {Entry} entry
 * @returns {Promise<'ok' | 'missing' | 'changed'>}
 */
async function state(entry) {
  let bytes
  try {
    bytes = await readFile(pathOf(entry))
  } catch {
    return 'missing'
  }
  return sha256(bytes) === entry.sha256 ? 'ok' : 'changed'
}

/**
 * Fetch one URL fully. The timer is reset by every piece that arrives, so a
 * slow connection is fine and a dead one is not waited on for ever.
 *
 * @param {string} url
 */
async function download(url) {
  const controller = new AbortController()
  let timer = setTimeout(() => controller.abort(), STALL_MS)
  try {
    const response = await fetch(url, { signal: controller.signal, redirect: 'follow' })
    if (!response.ok || !response.body) {
      // "Not found" will still be not found a second later; "busy" may not be.
      const worthRetrying = response.status >= 500 || response.status === 408 || response.status === 429
      throw Object.assign(new Error(`HTTP ${response.status}`), { permanent: !worthRetrying })
    }
    /** @type {Uint8Array[]} */
    const pieces = []
    for await (const piece of response.body) {
      clearTimeout(timer)
      timer = setTimeout(() => controller.abort(), STALL_MS)
      pieces.push(piece)
    }
    return new Uint8Array(Buffer.concat(pieces))
  } finally {
    clearTimeout(timer)
  }
}

/** What went wrong, including the reason Node tucks away behind "fetch failed". */
const reason = (/** @type {unknown} */ err) => {
  if (!(err instanceof Error)) return String(err)
  if (err.name === 'AbortError') return `no data for ${STALL_MS / 1000}s`
  const cause = err.cause instanceof Error ? ` (${err.cause.message})` : ''
  return `${err.message}${cause}`
}

/**
 * Get one file from the first source that serves the right bytes, trying each
 * a few times: one refused connection should not fail a whole CI run.
 *
 * @param {Entry} entry
 */
async function fetchEntry(entry) {
  for (const url of entry.urls) {
    for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
      try {
        const bytes = await download(url)
        // The hash is the whole point: a file that is not byte for byte the
        // one that was reviewed is not kept, whoever served it. Trying again
        // would not change what the source holds, so move to the next one.
        if (bytes.length !== entry.bytes || sha256(bytes) !== entry.sha256) {
          console.error(`  ${new URL(url).host}: not the expected file (${bytes.length} bytes, sha256 ${sha256(bytes).slice(0, 12)}…)`)
          break
        }
        // Written under another name first, so a download cut short never
        // leaves a file that looks complete.
        const partial = join(DIR, `${entry.name}.partial`)
        await writeFile(partial, bytes)
        await rename(partial, join(DIR, entry.name))
        return true
      } catch (err) {
        const last = attempt === ATTEMPTS || (err instanceof Error && 'permanent' in err && err.permanent === true)
        console.error(`  ${new URL(url).host}: ${reason(err)}${last ? '' : ', trying again'}`)
        await rm(join(DIR, `${entry.name}.partial`), { force: true })
        if (last) break
        await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt))
      }
    }
  }
  return false
}

// Checking changes nothing on disk, not even to make the folder.
if (!checkOnly) await mkdir(DIR, { recursive: true })
let failed = 0
for (const entry of manifest.files) {
  const found = await state(entry)
  if (found === 'ok') {
    console.log(`ok       ${entry.name}`)
    continue
  }
  // A sample is part of the repository. If it is missing or altered that is a
  // mistake in the working tree to put right with git, not something to
  // paper over with a download.
  if (checkOnly || entry.sample) {
    console.error(`${found.padEnd(8)} ${entry.sample ? `${entry.sample}/` : ''}${entry.name}`)
    failed++
    continue
  }
  // A file of the right name and the wrong contents must not be left to be
  // read by a test, whether or not the right one can be fetched.
  if (found === 'changed') await rm(join(DIR, entry.name), { force: true })
  if (await fetchEntry(entry)) {
    console.log(`fetched  ${entry.name} (${(entry.bytes / 1024 / 1024).toFixed(1)} MB)`)
  } else {
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
console.log(`\nall ${manifest.files.length} public test files are in place (samples/ and ${DIR})`)
