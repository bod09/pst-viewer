import { expect, test, type Page } from '@playwright/test'
import { emailFrame, fixture, messageList, openFiles, reader } from './support'

const searchBox = (page: Page) => page.getByRole('searchbox', { name: 'Search all mail…' })
const results = (page: Page) => page.getByRole('listbox', { name: 'Search results' }).getByRole('option')

/**
 * Type a query, and close the panel of filters if it is open under the box
 * (it opens when the box gains focus, and covers the first results).
 */
async function search(page: Page, query: string) {
  await searchBox(page).fill(query)
  const panel = page.getByText('Subject contains')
  if (await panel.isVisible()) await searchBox(page).press('Escape')
  await expect(panel).toBeHidden()
  await expect(searchBox(page)).toHaveValue(query)
}

test.beforeEach(async ({ page }) => {
  await openFiles(
    page,
    fixture('mail.eml'),
    fixture('spoof-sender.eml'),
    fixture('forwarded.eml'),
    fixture('hostile-html.eml'),
    fixture('mail.msg'),
  )
  await expect(messageList(page).getByRole('option')).toHaveCount(5)
})

test('a word finds the messages that contain it', async ({ page }) => {
  await search(page, 'pomegranate')
  await expect(results(page)).toHaveCount(2)
  await expect(results(page).filter({ hasText: 'Quarterly zebra report' })).toBeVisible()
  await expect(results(page).filter({ hasText: 'Distinctive msg subject wombat' })).toBeVisible()
})

test('a result opens the message, with the word marked', async ({ page }) => {
  await search(page, 'kumquat')
  await expect(results(page)).toHaveCount(1)
  await results(page).first().click()
  await expect(reader(page).getByRole('heading', { name: 'Hostile markup test' })).toBeVisible()
  await expect(emailFrame(page).locator('mark')).toHaveText('kumquat')
})

test('filters narrow by sender, attachment and importance', async ({ page }) => {
  await search(page, 'from:carol')
  await expect(results(page)).toHaveCount(1)
  await expect(results(page).first()).toContainText('Distinctive msg subject wombat')

  await search(page, 'has:attachment')
  await expect(results(page)).toHaveCount(2)

  await search(page, 'is:high')
  await expect(results(page)).toHaveCount(1)
  await expect(results(page).first()).toContainText('Fwd: Original walrus memo')
})

test('a quoted phrase must appear as written', async ({ page }) => {
  await search(page, '"zebra migration figures"')
  await expect(results(page)).toHaveCount(1)
  await search(page, '"figures migration zebra"')
  await expect(page.getByText('No matches for')).toBeVisible()
})

test('Escape closes the filter panel without throwing the query away', async ({ page }) => {
  await searchBox(page).fill('pomegranate')
  await expect(page.getByText('Subject contains')).toBeVisible()
  await searchBox(page).press('Escape')
  await expect(page.getByText('Subject contains')).toBeHidden()
  await expect(searchBox(page)).toHaveValue('pomegranate')
  await expect(results(page)).toHaveCount(2)
})

test('the filter panel builds the same query as typing it', async ({ page }) => {
  await searchBox(page).click()
  await page.getByPlaceholder('Name or address').first().fill('carol')
  await page.getByRole('button', { name: 'Has attachment' }).click()
  await page.getByRole('button', { name: 'Search', exact: true }).click()
  await expect(searchBox(page)).toHaveValue('from:carol has:attachment')
  await expect(page.getByText('No matches for')).toBeVisible()

  // Opening the panel again shows the query's filters, ready to change.
  await searchBox(page).click()
  await expect(page.getByPlaceholder('Name or address').first()).toHaveValue('carol')
  await page.getByRole('button', { name: 'Has attachment' }).click()
  await page.getByRole('button', { name: 'Search', exact: true }).click()
  await expect(searchBox(page)).toHaveValue('from:carol')
  await expect(results(page)).toHaveCount(1)
})

test('clearing the search brings the folder back', async ({ page }) => {
  await search(page, 'pomegranate')
  await expect(results(page)).toHaveCount(2)
  await page.getByRole('button', { name: 'Clear search' }).click()
  await expect(searchBox(page)).toHaveValue('')
  await expect(messageList(page).getByRole('option')).toHaveCount(5)
})
