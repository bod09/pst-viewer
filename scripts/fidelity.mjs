/**
 * Fidelity check: does the worker still read a mailbox the same way?
 *
 * Indexing is the part of this app where a change can look completely fine
 * (the right number of messages, sensible timings, search returning hits)
 * while quietly attaching the wrong content to the wrong message. Counts and
 * totals do not catch that. This does: it drives the real worker over a real
 * mailbox, records what every message actually says, and compares that
 * against a stored baseline, folder by folder and message by message.
 *
 * Usage:
 *   node scripts/fidelity.mjs <file> --update          # record a baseline
 *   node scripts/fidelity.mjs <file>                   # check against it
 *   node scripts/fidelity.mjs <file> --update --full   # hash every body, not 1 in 10
 *
 * <file> is a .pst, .ost, .msg, .eml or a .zip of them.
 *
 * Options:
 *   --full              with --update: hash every message body, not one in ten
 *   --redact            with --update: store hashes in place of all text from
 *                       the mailbox (see redact() in lib/fidelity.mjs)
 *   --baselines <dir>   where baselines are kept (default: .fidelity)
 *
 * A check always samples and redacts the way its baseline did, so --full and
 * --redact only mean anything while recording one.
 *
 * Mailboxes and baselines stay on your machine: a baseline holds real subjects
 * and sender names, so .fidelity/ is git-ignored along with the files it
 * describes. The baselines that are in the repository (tests/baselines/) are
 * of made-up mail, or redacted; `npm test` checks those.
 */
import { openAsBlob } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { check, loadWorker, redact, snapshotFile, unusable } from './lib/fidelity.mjs'

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const USAGE =
  'usage: node scripts/fidelity.mjs <mailbox.pst|.ost|.msg|.eml|.zip> [--update] [--full] [--redact] [--baselines <dir>]'

const args = process.argv.slice(2)
/** @type {string | undefined} */
let mailboxPath
let baselineDir = join(ROOT, '.fidelity')
const flags = new Set()
for (let i = 0; i < args.length; i++) {
  const arg = args[i]
  if (arg === '--baselines') {
    const dir = args[++i]
    if (!dir) fail(`--baselines needs a directory\n${USAGE}`)
    baselineDir = resolve(dir)
  } else if (['--update', '--full', '--redact'].includes(arg)) {
    flags.add(arg)
  } else if (arg.startsWith('--')) {
    fail(`unknown option ${arg}\n${USAGE}`)
  } else if (mailboxPath) {
    fail(`one mailbox at a time, got ${mailboxPath} and ${arg}\n${USAGE}`)
  } else {
    mailboxPath = arg
  }
}
if (!mailboxPath) fail(USAGE)
const update = flags.has('--update')
if (!update && (flags.has('--full') || flags.has('--redact'))) {
  fail('--full and --redact only apply with --update: a check follows its baseline')
}

/** @param {string} message @returns {never} */
function fail(message) {
  console.error(message)
  process.exit(2)
}

const name = basename(mailboxPath)
const baselinePath = join(baselineDir, `${name}.json`)

let baseline
if (!update) {
  let stored
  try {
    stored = await readFile(baselinePath, 'utf8')
  } catch {
    fail(`no baseline for ${name}. Record one first:\n  node scripts/fidelity.mjs ${mailboxPath} --update`)
  }
  try {
    baseline = JSON.parse(stored)
  } catch {
    baseline = null
  }
  // A baseline that cannot be compared is refused rather than compared: it
  // would fail on every row and read like a real regression.
  const why = unusable(baseline)
  if (why) {
    fail(
      `the baseline for ${name} cannot be used: ${why}. Record it again, on a version you trust:\n` +
        `  node scripts/fidelity.mjs ${mailboxPath} --update`,
    )
  }
}

const t0 = Date.now()
let blob
try {
  blob = await openAsBlob(mailboxPath)
} catch (err) {
  fail(`cannot read ${mailboxPath}: ${err instanceof Error ? err.message : err}`)
}
const file = new File([blob], name)
const { api, scanZip } = await loadWorker()
const secs = () => ((Date.now() - t0) / 1000).toFixed(1)

if (update) {
  const plain = await snapshotFile(api, file, { full: flags.has('--full'), scanZip })
  const snapshot = flags.has('--redact') ? redact(plain) : plain
  await mkdir(baselineDir, { recursive: true })
  await writeFile(baselinePath, JSON.stringify(snapshot, null, 1) + '\n')
  console.log(
    `baseline written: ${snapshot.messages} messages in ${snapshot.folders.length} folders ` +
      `(${snapshot.bodies} bodies hashed${snapshot.redacted ? ', text redacted' : ''}) in ${secs()}s\n  ${baselinePath}`,
  )
  process.exit(0)
}

const { problems, current } = await check(api, file, baseline, scanZip)
if (problems.length === 0) {
  console.log(
    `FIDELITY OK: ${current.messages} messages in ${current.folders.length} folders ` +
      `match the baseline exactly (${current.bodies} bodies hashed, ${secs()}s)`,
  )
  process.exit(0)
}
// The list is capped, so a full one means "at least this many".
const count = problems.length >= 30 ? 'at least 30 differences' : `${problems.length} difference(s)`
console.error(`FIDELITY FAILED for ${name}: ${count}`)
for (const p of problems) console.error('  ' + p)
process.exit(1)
