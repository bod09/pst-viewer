import { expect, fixture, messageList, openFiles, openMessage, publicMailboxPath, reader, test } from './support'

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

// Messages saved in an 8-bit code page are decoded by a stand-in for the
// iconv-lite library that only the browser build uses (src/lib/iconv-lite-shim.ts),
// so the browser is the one place the real thing can be checked.
test('a message saved in a Japanese code page shows Japanese text', async ({ page }) => {
  await openFiles(page, publicMailboxPath('nonUnicodeCP932.msg'))
  await expect(messageList(page).getByRole('option')).toHaveCount(1)
  await messageList(page).getByRole('option').first().getByRole('button').click()
  const shown = await reader(page).innerText()
  expect(shown).toMatch(/[\u3040-\u30ff\u4e00-\u9fff]/)
  expect(shown).not.toContain('\uFFFD')
})

test('a contact saved in 8-bit text opens as the same card as its Unicode twin', async ({ page }) => {
  const card = async (name: string) => {
    await openFiles(page, publicMailboxPath(name))
    await messageList(page).getByRole('option').first().getByRole('button').click()
    await expect(reader(page).locator('a[href^="mailto:"]').first()).toBeVisible()
    const text = await reader(page).innerText()
    await page.getByRole('button', { name: /^Remove / }).click()
    await expect(page.getByRole('heading', { name: 'Open your mailbox' })).toBeVisible()
    return text
  }
  const ansi = await card('contactAnsi.msg')
  expect(ansi).not.toContain('\uFFFD')
  expect(ansi).toBe(await card('contactUnicode.msg'))
})

