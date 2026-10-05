import { type Page } from '@playwright/test'
import { expect, messageList, openFiles, publicMailboxPath, setSetting, test } from './support'

/**
 * The search index of a mailbox is kept on the device, so opening the same
 * file again does not read it all a second time. A stale or partial index
 * would show as mail that can no longer be found, which is what this checks.
 */
const searchBox = (page: Page) => page.getByRole('searchbox', { name: 'Search all mail…' })
const results = (page: Page) => page.getByRole('listbox', { name: 'Search results' }).getByRole('option')

/**
 * How many messages a query finds.
 *
 * Results from the search before stay on screen until the next one finishes,
 * so reading the count straight after typing can read the old one. A search
 * for nonsense is run first: its "No matches" line names the query, which
 * proves the list is empty, and anything listed after that belongs to `query`.
 */
async function countFor(page: Page, query: string): Promise<number> {
  const nonsense = 'zzqxjvkw'
  await searchBox(page).fill(nonsense)
  await expect(page.getByText(`No matches for \u201c${nonsense}\u201d.`)).toBeVisible()
  await searchBox(page).fill(query)
  if (await page.getByText('Subject contains').isVisible()) await searchBox(page).press('Escape')
  await expect(searchBox(page)).toHaveValue(query)
  await expect(results(page).first()).toBeVisible()
  // Results are drawn only as they scroll into view, so they cannot simply be
  // counted; the heading above them gives the total.
  const heading = page.getByText('Search results', { exact: true }).locator('..')
  await expect(heading).toHaveText(/Search results\s*[\d,]+/)
  return Number((await heading.innerText()).replace(/\D/g, ''))
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
  // Two different questions with two different answers, or the comparison
  // after the reload would prove nothing.
  expect(first.phrase).not.toBe(first.attachments)
  const stored = () => page.evaluate(async () => (await indexedDB.databases()).map((d) => d.name))
  expect((await stored()).length).toBeGreaterThan(0)

  await page.reload()
  await expect(page.getByText('This page was reloaded')).toBeVisible()
  await openAndWait(page)
  expect(await countFor(page, 'has:attachment')).toBe(first.attachments)
  // An exact phrase is checked against the stored text, not just the index.
  expect(await countFor(page, phrase)).toBe(first.phrase)
})
