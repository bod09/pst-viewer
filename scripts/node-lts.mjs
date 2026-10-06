/**
 * Is the Node version this repository pins still the newest Long Term
 * Support release?
 *
 * The pin is the major in .nvmrc, and the same number is meant to be in
 * package.json (`engines`), the workflows (which read .nvmrc), the Dockerfile
 * and `@types/node`. Dependabot cannot tell an LTS release from any other
 * (every even major is released six months before it becomes LTS, and odd
 * majors never do), so a workflow runs this once a week against the Node
 * project's own schedule and opens an issue when a newer LTS has started.
 *
 *   node scripts/node-lts.mjs                       # asks nodejs.org's schedule
 *   node scripts/node-lts.mjs --schedule file.json  # uses a saved one
 *   node scripts/node-lts.mjs --today 2026-10-28    # as of another day
 *
 * Prints `pinned=<major>` and `newest=<major>`. Exits 0 when they match,
 * 3 when a newer LTS is out, 2 when the question could not be answered.
 */
import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'

const SCHEDULE_URL = 'https://raw.githubusercontent.com/nodejs/Release/main/schedule.json'

/**
 * The newest major that is in LTS on `today`: its `lts` date has passed and
 * its `end` date has not. Majors that never get an `lts` date are skipped.
 *
 * @param {Record<string, { lts?: string | null, end?: string }>} schedule
 * @param {string} today YYYY-MM-DD
 * @returns {number | null}
 */
export function newestLts(schedule, today) {
  let newest = null
  for (const [name, dates] of Object.entries(schedule)) {
    const major = Number(name.replace(/^v/, ''))
    if (!Number.isInteger(major) || !dates.lts || !dates.end) continue
    if (dates.lts <= today && today < dates.end && (newest === null || major > newest)) newest = major
  }
  return newest
}

/**
 * The major pinned in .nvmrc ("24", "24.1.0" or "v24" all mean 24).
 *
 * @param {string} nvmrc
 */
export function pinnedMajor(nvmrc) {
  const m = /^\s*v?(\d+)/.exec(nvmrc)
  return m ? Number(m[1]) : null
}

async function main() {
  const args = process.argv.slice(2)
  let today = new Date().toISOString().slice(0, 10)
  let schedulePath = null
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--today' && args[i + 1]) today = args[++i]
    else if (args[i] === '--schedule' && args[i + 1]) schedulePath = args[++i]
    else fail(`unknown argument ${args[i]}\nusage: node scripts/node-lts.mjs [--schedule <file>] [--today YYYY-MM-DD]`)
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(today)) fail(`--today needs YYYY-MM-DD, got ${today}`)

  const root = new URL('..', import.meta.url)
  const pinned = pinnedMajor(await readFile(new URL('.nvmrc', root), 'utf8'))
  if (pinned === null) fail('.nvmrc does not name a Node major')

  let schedule
  try {
    const text = schedulePath ? await readFile(schedulePath, 'utf8') : await (await fetch(SCHEDULE_URL)).text()
    schedule = JSON.parse(text)
  } catch (err) {
    fail(`could not read the Node release schedule: ${err instanceof Error ? err.message : err}`)
  }
  const newest = newestLts(schedule, today)
  if (newest === null) fail('the schedule names no release in LTS today')

  console.log(`pinned=${pinned}`)
  console.log(`newest=${newest}`)
  process.exit(newest > pinned ? 3 : 0)
}

/** @param {string} message @returns {never} */
function fail(message) {
  console.error(message)
  process.exit(2)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main()
