import { expect, test } from '@playwright/test'
import { fixture, messageList, openFiles, openMessage, publicMailboxPath, reader } from './support'

test('an attached picture opens in a preview, and Escape closes it', async ({ page }) => {
  await openFiles(page, fixture('mail.eml'))
  await openMessage(page, 'Quarterly zebra report')
  await reader(page).getByRole('button', { name: /chart\.png/ }).click()
  const preview = page.getByRole('dialog', { name: 'chart.png' })
  await expect(preview).toBeVisible()
  const image = preview.locator('img')
  await expect(image).toHaveAttribute('src', /^blob:/)
  expect(await image.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(2)
  await page.keyboard.press('Escape')
  await expect(preview).toBeHidden()
})

test('the original headers of a message can be read', async ({ page }) => {
  await openFiles(page, fixture('mail.eml'))
  await openMessage(page, 'Quarterly zebra report')
  await reader(page).getByRole('button', { name: 'Headers' }).click()
  await expect(page.getByRole('dialog')).toContainText('From: Alice Example <alice@example.com>')
  await expect(page.getByRole('dialog')).toContainText('Content-Type: multipart/mixed')
})

test('a contact opens as a card, not as an empty email', async ({ page }) => {
  await openFiles(page, publicMailboxPath('contacts.pst'))
  await expect(messageList(page).getByRole('option').first()).toBeVisible()
  await messageList(page).getByRole('option').first().getByRole('button').click()
  await expect(reader(page).locator('a[href^="mailto:"]').first()).toBeVisible()
  await expect(page.locator('iframe[title="Email content"]')).toHaveCount(0)
})
