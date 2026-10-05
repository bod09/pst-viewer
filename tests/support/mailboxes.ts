import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/**
 * The public test files: real .pst and .ost mailboxes and .msg messages, from
 * the test data of the libraries that read them (pst-extractor and
 * msgreader), listed in tests/public-mailboxes.json.
 *
 * Most are synthetic, with nothing personal in them, and are kept in the
 * repository under samples/. A few hold real people's mail and are not:
 * `npm run mailboxes` downloads those into fixtures/public/.
 *
 * A test that needs a file that has not been downloaded is skipped, so a
 * fresh clone with no network still runs everything else. In CI (or with
 * REQUIRE_MAILBOXES=1) every file is required instead: a skipped test there
 * would be a check that silently stopped checking.
 */
const ROOT = fileURLToPath(new URL('../../', import.meta.url))

interface Entry {
  name: string
  bytes: number
  sha256: string
  urls: string[]
  /** The folder in this repository that holds the file, when it is kept here. */
  sample?: string
}
// Read with fs, not imported, so that Playwright's loader can use this file too.
const manifest: { files: Entry[] } = JSON.parse(readFileSync(`${ROOT}tests/public-mailboxes.json`, 'utf8'))

/** Where a public test file is, or would be once downloaded. */
export function publicFilePath(name: string): string {
  const entry = manifest.files.find((f) => f.name === name)
  if (!entry) throw new Error(`${name} is not listed in tests/public-mailboxes.json`)
  return `${ROOT}${entry.sample ?? 'fixtures/public'}/${name}`
}

/** Whether a missing file is a failure (CI) or just a reason to skip (a fresh clone). */
export const requirePublicMailboxes = Boolean(process.env.CI) || process.env.REQUIRE_MAILBOXES === '1'

/** Whether this file can be used: it is here, or it must be (and the test should fail saying so). */
export const usable = (name: string): boolean => requirePublicMailboxes || existsSync(publicFilePath(name))

const names = manifest.files.map((f) => f.name)

/** Every public test file, wherever it is kept. */
export const publicFileNames = names
/** The files kept in this repository, under samples/. */
export const sampleFileNames = manifest.files.filter((f) => f.sample).map((f) => f.name)
/** The .pst and .ost mailboxes that can be used on this machine. */
export const publicMailboxNames = names.filter((n) => /\.(pst|ost)$/i.test(n)).filter(usable)
/** The loose .msg messages that can be used on this machine. */
export const publicMessageNames = names.filter((n) => /\.msg$/i.test(n)).filter(usable)
/** How many files are missing and would have to be downloaded. */
export const missingPublicFiles = names.filter((n) => !existsSync(publicFilePath(n))).length

/** One of the public test files as a File, checked against its recorded hash. */
export function publicMailbox(name: string): File {
  const path = publicFilePath(name)
  const entry = manifest.files.find((f) => f.name === name)!
  let bytes: Buffer
  try {
    bytes = readFileSync(path)
  } catch {
    throw new Error(`${name} has not been downloaded. Run: npm run mailboxes`)
  }
  // A file that is not the one the baselines were recorded from would fail in
  // confusing ways further on; say what is actually wrong.
  if (createHash('sha256').update(bytes).digest('hex') !== entry.sha256) {
    throw new Error(
      entry.sample
        ? `${entry.sample}/${name} is not the file recorded in tests/public-mailboxes.json`
        : `${name} is not the expected file. Delete fixtures/public and run: npm run mailboxes`,
    )
  }
  return new File([bytes as Uint8Array<ArrayBuffer>], name, { lastModified: 1_700_000_000_000 })
}
