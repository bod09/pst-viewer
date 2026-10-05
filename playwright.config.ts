import { defineConfig, devices } from '@playwright/test'

/**
 * Browser tests: the built app, driven in a real browser the way a person
 * would use it (tests/e2e/).
 *
 * They run against a production build, not the dev server, because that is
 * what ships: the bundled worker, the service worker and the content security
 * policy only exist there. Two copies are built and served, one at the root
 * and one under /pst-viewer/, which is where GitHub Pages serves it. A path
 * that only works at the root is an easy mistake to make and to miss.
 */
const ROOT_PORT = 4174
const SUBPATH_PORT = 4175
const SUBPATH = '/pst-viewer/'
const CI = Boolean(process.env.CI)

export default defineConfig({
  testDir: 'tests/e2e',
  outputDir: 'test-results',
  fullyParallel: true,
  // A test left as `.only` would switch all the others off without anyone noticing.
  forbidOnly: CI,
  // One retry in CI, so a hiccup on a shared runner does not block a merge.
  // A test that needed it is reported as flaky, which is a bug to fix.
  retries: CI ? 1 : 0,
  reporter: CI ? [['github'], ['list'], ['html', { open: 'never' }]] : [['list']],
  timeout: 30_000,
  expect: { timeout: 10_000 },
  use: {
    // What a failed test leaves behind to look at (test-results/, and the report in CI).
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    // Each test starts from a clean browser; the service worker would carry
    // one build's files into the next run. (offline.spec.ts turns it back on.)
    serviceWorkers: 'block',
    // Fixed, and not UTC, for the same reason as in tests/support/global-setup.ts.
    timezoneId: 'Asia/Tokyo',
    locale: 'en-GB',
  },
  projects: [
    {
      name: 'chromium',
      testIgnore: /subpath\.spec\.ts$/,
      use: { ...devices['Desktop Chrome'], baseURL: `http://localhost:${ROOT_PORT}/` },
    },
    {
      name: 'subpath',
      testMatch: /subpath\.spec\.ts$/,
      use: { ...devices['Desktop Chrome'], baseURL: `http://localhost:${SUBPATH_PORT}${SUBPATH}` },
    },
  ],
  webServer: [
    {
      // A fresh build every time: testing a stale one proves nothing. (While
      // writing a test, `npm run test:e2e -- --ui` builds once and stays open.)
      command: `npx vite build --outDir .e2e/root --logLevel warn && npx vite preview --outDir .e2e/root --port ${ROOT_PORT} --strictPort`,
      url: `http://localhost:${ROOT_PORT}/`,
      reuseExistingServer: false,
      timeout: 180_000,
    },
    {
      command: `npx vite build --outDir .e2e/subpath --logLevel warn && npx vite preview --outDir .e2e/subpath --port ${SUBPATH_PORT} --strictPort`,
      url: `http://localhost:${SUBPATH_PORT}${SUBPATH}`,
      env: { BASE_PATH: SUBPATH },
      reuseExistingServer: false,
      timeout: 180_000,
    },
  ],
})
