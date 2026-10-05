import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { expect, test, type FrameLocator, type Page, type Request } from '@playwright/test'
import { fixtureFiles } from '../support/fixtures.mjs'

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
 * The path of one of the public test mailboxes (see `npm run mailboxes`).
 * Without it the test is skipped, except in CI, where it must be there.
 */
export function publicMailboxPath(name: string): string {
  const path = fileURLToPath(new URL(`../../fixtures/public/${name}`, import.meta.url))
  const here = existsSync(path)
  if (!here && process.env.CI) throw new Error(`${name} has not been downloaded. Run: npm run mailboxes`)
  test.skip(!here, 'public mailboxes are not downloaded (npm run mailboxes)')
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

/**
 * Watch every request the page makes and sort out the ones that leave the
 * app's own origin. Those are answered here (never by the real internet), so
 * a test both sees what was asked for and stays offline.
 */
export async function watchRequests(page: Page) {
  const outside: string[] = []
  const own = new URL(test.info().project.use.baseURL!).origin
  // A one pixel GIF, so a remote picture that is allowed does load.
  const pixel = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64')
  await page.context().route(
    (url) => !['data:', 'blob:', 'about:'].includes(url.protocol) && url.origin !== own,
    async (route) => {
      outside.push(route.request().url())
      const type = route.request().resourceType()
      if (type === 'image') await route.fulfill({ contentType: 'image/gif', body: pixel })
      else await route.fulfill({ contentType: 'text/plain', body: '' })
    },
  )
  const all: Request[] = []
  page.on('request', (r) => all.push(r))
  return {
    /** URLs requested from anywhere but the app itself. */
    outside,
    /** Every request, for checking what the app loads of its own. */
    all,
  }
}
