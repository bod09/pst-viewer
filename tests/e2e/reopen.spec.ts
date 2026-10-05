import { expect, test, type Page } from '@playwright/test'
import { messageList, openFiles, publicMailboxPath, setSetting } from './support'

/**
 * The search index of a mailbox is kept on the device, so opening the same
 * file again does not read it all a second time. A stale or partial index
 * would show as mail that can no longer be found, which is what this checks.
 */
const searchBox = (page: Page) => page.getByRole('searchbox', { name: 'Search all mail…' })
const results = (page: Page) => page.getByRole('listbox', { name: 'Search results' }).getByRole('option')

async function countFor(page: Page, query: string): Promise<number> {
  await searchBox(page).fill(query)
  if (await page.getByText('Subject contains').isVisible()) await searchBox(page).press('Escape')
  await expect(page.getByText(/^Search results/)).toBeVisible()
  const header = page.locator('section').filter({ hasText: /^Search results/ })
  // The header shows the number of results once there are any.
  await expect(results(page).first()).toBeVisible()
  return Number((await header.locator('span').nth(1).innerText()).replace(/\D/g, ''))
}

async function openAndWait(page: Page) {
  await openFiles(page, publicMailboxPath('enron.pst'))
  await expect(messageList(page).getByRole('option').first()).toBeVisible()
  await expect(page.getByText(/Indexing for search/)).toHaveCount(0)
}

test('a mailbox opened a second time is searched as completely as the first', async ({ page }) => {
  await page.goto('./')
  // Reading text out of pictures goes on in the background and adds to the
  // index as it goes; off, the two openings have the same thing to compare.
  await setSetting(page, 'Make text in images searchable', false)
  await openAndWait(page)
  // A subject taken from the mailbox as it is shown, so none is written here.
  // (The last line of a row in the list is the subject.)
  const row = messageList(page).getByRole('option').first().getByRole('button')
  const subject = (await row.locator(':scope > :last-child').innerText()).trim()
  const phrase = `"${subject.replace(/"/g, '')}"`

  const first = { attachments: await countFor(page, 'has:attachment'), phrase: await countFor(page, phrase) }
  expect(first.attachments).toBeGreaterThan(10)
  expect(first.phrase).toBeGreaterThan(0)
  const stored = () => page.evaluate(async () => (await indexedDB.databases()).map((d) => d.name))
  expect((await stored()).length).toBeGreaterThan(0)

  await page.reload()
  await expect(page.getByText('This page was reloaded')).toBeVisible()
  await openAndWait(page)
  expect(await countFor(page, 'has:attachment')).toBe(first.attachments)
  // An exact phrase is checked against the stored text, not just the index.
  expect(await countFor(page, phrase)).toBe(first.phrase)
})
