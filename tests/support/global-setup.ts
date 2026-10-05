import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/**
 * Runs once before any test.
 *
 * Tests run in a fixed timezone, so a date means the same thing on every
 * machine. It is deliberately not UTC: code that mixes up local time and UTC
 * (a date filter, a file name with a date in it) gives the right answer in UTC
 * by accident, and the wrong one nine hours east of it. Tokyo has no daylight
 * saving, so the offset is +09:00 all year.
 */
export function setup(): void {
  process.env.TZ = 'Asia/Tokyo'

  // Said here, once and up front, because a line in the summary reading
  // "40 skipped" does not say why, or what to do about it.
  const root = fileURLToPath(new URL('../../', import.meta.url))
  const manifest: { files: { name: string; sample?: string }[] } = JSON.parse(
    readFileSync(`${root}tests/public-mailboxes.json`, 'utf8'),
  )
  const missing = manifest.files.filter((f) => !existsSync(`${root}${f.sample ?? 'fixtures/public'}/${f.name}`))
  if (missing.length > 0 && !process.env.CI) {
    console.warn(
      `\n  Note: ${missing.length} public test files are not downloaded (${missing.map((f) => f.name).join(', ')}),\n` +
        '  so the tests that read them will be skipped. To run them too:\n\n' +
        '      npm run mailboxes\n',
    )
  }
}
