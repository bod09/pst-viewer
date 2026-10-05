import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import manifest from '../public-mailboxes.json' with { type: 'json' }

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
  // "78 skipped" does not say why, or what to do about it.
  const dir = fileURLToPath(new URL('../../fixtures/public/', import.meta.url))
  const missing = manifest.files.filter((f) => !existsSync(dir + f.name)).length
  if (missing > 0 && !process.env.CI) {
    console.warn(
      `\n  Note: ${missing} of ${manifest.files.length} public test files are not downloaded, so the tests\n` +
        '  that read real .pst, .ost and .msg files will be skipped. To run them too:\n\n' +
        '      npm run mailboxes\n',
    )
  }
}
