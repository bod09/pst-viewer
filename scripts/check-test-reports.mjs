/**
 * Fail if any test was skipped. CI only (`CI=true npm test` and
 * `npm run test:e2e` write the reports this reads).
 *
 * Tests are allowed to skip themselves on a developer's machine, when the
 * public test files have not been downloaded. In CI everything is there, so a
 * skipped test means a check that has quietly stopped checking: a `.skip` left
 * in, a condition that is never true, a file that failed to download. The
 * test runners report all of those as success. This does not.
 *
 *   node scripts/check-test-reports.mjs vitest       # test-results/vitest.json
 *   node scripts/check-test-reports.mjs playwright   # test-results/playwright.json
 */
import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const which = process.argv[2]
if (which !== 'vitest' && which !== 'playwright') {
  console.error('usage: node scripts/check-test-reports.mjs <vitest|playwright>')
  process.exit(2)
}

const path = join(ROOT, 'test-results', `${which}.json`)
let report
try {
  report = JSON.parse(await readFile(path, 'utf8'))
} catch {
  // No report is not "nothing was skipped". It means the tests did not run
  // the way this expects, which is the kind of thing this exists to catch.
  console.error(`no test report at ${path}: did the tests run with CI=true?`)
  process.exit(1)
}

/** @type {{ ran: number, skipped: number, flaky: number, names: string[] }} */
const found = { ran: 0, skipped: 0, flaky: 0, names: [] }

if (which === 'vitest') {
  found.ran = report.numPassedTests + report.numFailedTests
  found.skipped = report.numPendingTests + report.numTodoTests
  for (const file of report.testResults ?? []) {
    for (const t of file.assertionResults ?? []) {
      if (t.status !== 'passed' && t.status !== 'failed') found.names.push(t.fullName)
    }
  }
} else {
  found.ran = report.stats.expected + report.stats.unexpected + report.stats.flaky
  found.skipped = report.stats.skipped
  found.flaky = report.stats.flaky
  /** @param {{ title: string, suites?: unknown[], specs?: { title: string, tests: { status: string }[] }[] }} suite @param {string} prefix */
  const walk = (suite, prefix) => {
    for (const spec of suite.specs ?? []) {
      if (spec.tests.some((t) => t.status === 'skipped')) found.names.push(`${prefix}${spec.title}`)
    }
    for (const child of /** @type {any[]} */ (suite.suites ?? [])) walk(child, `${prefix}${child.title} > `)
  }
  for (const suite of report.suites ?? []) walk(suite, `${suite.title} > `)
}

if (found.ran === 0) {
  console.error(`${which}: no tests ran at all`)
  process.exit(1)
}
if (found.flaky) {
  // Reported, not failed: a retry passed. It is still a bug to fix.
  console.log(`${which}: ${found.flaky} test(s) passed only on a second try. See the uploaded report.`)
}
if (found.skipped > 0) {
  console.error(`${which}: ${found.skipped} test(s) were skipped. In CI every test must run.`)
  for (const name of found.names.slice(0, 20)) console.error(`  ${name}`)
  process.exit(1)
}
console.log(`${which}: ${found.ran} tests ran, none skipped`)
