import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import manifest from '../public-mailboxes.json' with { type: 'json' }

/**
 * The public test files: real .pst and .ost mailboxes and .msg messages, from
 * the test data of the libraries that read them (pst-extractor and
 * msgreader). They are too large, and not ours, to keep in the
 * repository, so `npm run mailboxes` downloads them (see
 * scripts/fetch-mailboxes.mjs) into fixtures/public/.
 *
 * Tests that need them are skipped when they are not there, so the fast tests
 * work on a fresh clone with no network. In CI they are required instead: a
 * skipped test there would be a check that silently stopped checking.
 */
const DIR = fileURLToPath(new URL('../../fixtures/public/', import.meta.url))

const names = manifest.files.map((f) => f.name)

/** Every public test file. */
export const publicFileNames = names
/** The .pst and .ost mailboxes among them. */
export const publicMailboxNames = names.filter((n) => /\.(pst|ost)$/i.test(n))
/** The loose .msg messages among them. */
export const publicMessageNames = names.filter((n) => /\.msg$/i.test(n))

/** Whether every public mailbox has been downloaded. */
export const havePublicMailboxes = manifest.files.every((f) => existsSync(DIR + f.name))

/** Whether their absence is a failure (CI) or just a reason to skip (a fresh clone). */
export const requirePublicMailboxes = Boolean(process.env.CI) || process.env.REQUIRE_MAILBOXES === '1'

/** One of the public mailboxes as a File, checked against its recorded hash. */
export function publicMailbox(name: string): File {
  const entry = manifest.files.find((f) => f.name === name)
  if (!entry) throw new Error(`${name} is not listed in tests/public-mailboxes.json`)
  let bytes: Buffer
  try {
    bytes = readFileSync(DIR + name)
  } catch {
    throw new Error(`${name} has not been downloaded. Run: npm run mailboxes`)
  }
  // A file that is not the one the baselines were recorded from would fail in
  // confusing ways further on; say what is actually wrong.
  if (createHash('sha256').update(bytes).digest('hex') !== entry.sha256) {
    throw new Error(`${name} is not the expected file. Delete fixtures/public and run: npm run mailboxes`)
  }
  return new File([bytes as Uint8Array<ArrayBuffer>], name, { lastModified: 1_700_000_000_000 })
}
