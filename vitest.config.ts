import { defineConfig } from 'vitest/config'
import { alias } from './vite.config.ts'

const stub = new URL('./tests/support/comlink-stub.ts', import.meta.url).pathname

export default defineConfig({
  resolve: { alias: { ...alias, comlink: stub } },
  test: {
    include: ['tests/unit/**/*.test.ts', 'tests/worker/**/*.test.ts'],
    globalSetup: ['tests/support/global-setup.ts'],
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
