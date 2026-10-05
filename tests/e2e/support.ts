import { existsSync } from 'node:fs'
import { expect, test as base, type FrameLocator, type Page, type Request } from '@playwright/test'
import { fixtureFiles } from '../support/fixtures.mjs'
import { publicFilePath, requirePublicMailboxes } from '../support/mailboxes'

/** What `requests` gives a test: see the fixture below. */
export interface Requests {
  /** URLs requested from anywhere but the app itself. */
  outside: string[]
  /** Every request, for checking what the app loads of its own. */
  all: Request[]
}

/**
 * The `test` every spec uses, in place of Playwright's own.
 *
 * It adds one thing, for every test whether it asks or not: any request that
 * leaves the app's own origin is recorded and answered here, never by the
 * real internet. So a test can assert on what a message tried to fetch
 * (`requests.outside`), and no test can touch the network by accident.
 */
export const test = base.extend<{ requests: Requests }>({
  requests: [
    async ({ context, page, baseURL }, use) => {
      const own = new URL(baseURL!).origin
      const requests: Requests = { outside: [], all: [] }
      // A one pixel GIF, so a remote picture that is allowed does load.
      const pixel = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64')
      await context.route(
        (url) => !['data:', 'blob:', 'about:'].includes(url.protocol) && url.origin !== own,
        async (route) => {
          requests.outside.push(route.request().url())
          if (route.request().resourceType() === 'image') await route.fulfill({ contentType: 'image/gif', body: pixel })
          else await route.fulfill({ contentType: 'text/html', body: '<title>outside</title>' })
        },
      )
      page.on('request', (r) => requests.all.push(r))
      await use(requests)
    },
    { auto: true },
  ],
})
export { expect }

/** A file to hand to the app, as if it had been dropped on it. */
export interface Upload {
  name: string
  mimeType: string
  buffer: Buffer
}

export const upload = (name: string, bytes: Uint8Array | string): Upload => ({
  name,
  mimeType: 'application/octet-stream',
  buffer: Buffer.from(bytes),
})

/** One of the made-up files from tests/support/fixtures.mjs. */
export function fixture(name: string): Upload {
  const bytes = fixtureFiles()[name]
  if (!bytes) throw new Error(`no fixture called ${name}`)
  return upload(name, bytes)
}

/**
 * The path of one of the public test files: in samples/ if it is kept in the
 * repository, otherwise where `npm run mailboxes` downloads it. If it has
 * not been downloaded the test is skipped, except in CI or with
 * REQUIRE_MAILBOXES=1, where it must be there.
 */
export function publicMailboxPath(name: string): string {
  const path = publicFilePath(name)
  const here = existsSync(path)
  if (!here && requirePublicMailboxes) throw new Error(`${name} has not been downloaded. Run: npm run mailboxes`)
  test.skip(!here, 'public test files are not downloaded (npm run mailboxes)')
  return path
}

/** Open the app and give it files, through the same input the "Browse files" button uses. */
export async function openFiles(page: Page, ...files: (Upload | string)[]): Promise<void> {
  if (page.url() === 'about:blank') await page.goto('./')
  await page.locator('input[type=file]').first().setInputFiles(files as Upload[])
}

/** The row of a folder in the sidebar. */
export const folderRow = (page: Page, name: string | RegExp) =>
  page.getByRole('treeitem').filter({ hasText: name }).first()

/** The message list, and one message in it by its subject. */
export const messageList = (page: Page) => page.getByRole('listbox', { name: 'Messages' })
export const messageRow = (page: Page, subject: string | RegExp) =>
  messageList(page).getByRole('option').filter({ hasText: subject }).first()

/** The pane a message is read in: its heading, its people, its body and attachments. */
export const reader = (page: Page) =>
  page.locator('section').filter({ has: page.getByRole('heading', { level: 1 }) }).last()

/** Open a message from the list and wait for the reader to show it. */
export async function openMessage(page: Page, subject: string): Promise<void> {
  await messageRow(page, subject).getByRole('button').click()
  await expect(reader(page).getByRole('heading', { name: subject })).toBeVisible()
}

/** The sandboxed frame an HTML message is shown in. */
export const emailFrame = (page: Page): FrameLocator => page.frameLocator('iframe[title="Email content"]')

/** Turn a setting on or off, by the label next to its switch. */
export async function setSetting(page: Page, label: string, on: boolean): Promise<void> {
  await page.getByRole('button', { name: 'Settings' }).click()
  const dialog = page.getByRole('dialog', { name: 'Settings' })
  const toggle = dialog.getByRole('switch', { name: label })
  if ((await toggle.getAttribute('aria-checked')) !== String(on)) await toggle.click()
  await expect(toggle).toHaveAttribute('aria-checked', String(on))
  await dialog.getByRole('button', { name: 'Close' }).click()
  await expect(dialog).toBeHidden()
}
