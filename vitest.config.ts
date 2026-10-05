import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'
import { alias } from './vite.config.ts'

const stub = fileURLToPath(new URL('./tests/support/comlink-stub.ts', import.meta.url))
const CI = Boolean(process.env.CI)

export default defineConfig({
  // `comlink` is replaced so the worker's API can be called directly (see the
  // stub). The app's own aliases are applied to the code under src/; a
  // dependency that Node loads for itself, such as the .msg reader, does not
  // see them, so the iconv-lite stand-in is exercised by its own unit tests
  // and by the browser tests, not by the worker tests.
  resolve: { alias: { ...alias, comlink: stub } },
  test: {
    // Only these two directories hold tests, and only as *.test.ts. A test
    // file anywhere else, or named otherwise, would never run:
    // tests/unit/layout.test.ts fails if one appears.
    include: ['tests/unit/**/*.test.ts', 'tests/worker/**/*.test.ts'],
    globalSetup: ['tests/support/global-setup.ts'],
    // Generous, because the slowest tests read whole mailboxes and a shared
    // CI machine can be several times slower than a desktop.
    testTimeout: 30_000,
    hookTimeout: 60_000,
    // In CI a machine-readable report is written as well, which
    // scripts/check-test-reports.mjs reads to make sure nothing was skipped.
    reporters: CI ? ['default', 'json'] : ['default'],
    outputFile: { json: 'test-results/vitest.json' },
    coverage: {
      provider: 'v8',
      // What these tests can reach. The components and the store are covered
      // by the browser tests instead (tests/e2e), which are not measured here.
      include: ['src/lib/**/*.ts', 'src/worker/**/*.ts'],
      reporter: ['text-summary', 'html'],
      // The code that stands between a hostile message and the reader, or
      // decides what an exported file says, has to stay tested: a change that
      // adds untested paths to one of these fails `npm run test:coverage`.
      // (Only files the made-up fixtures reach are listed, so this does not
      // depend on the public test files being downloaded.)
      thresholds: {
        'src/lib/sanitizeHtml.ts': { lines: 95, branches: 90 },
        'src/lib/bulkExport.ts': { lines: 95, branches: 90 },
        'src/lib/emlExport.ts': { lines: 85, branches: 90 },
        'src/lib/mime.ts': { lines: 90, branches: 85 },
        'src/worker/eml.ts': { lines: 85, branches: 70 },
      },
    },
  },
})
