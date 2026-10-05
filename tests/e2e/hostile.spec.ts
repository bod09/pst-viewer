import { type Page } from '@playwright/test'
import { emailFrame, expect, fixture, openFiles, openMessage, setSetting, test } from './support'

/**
 * A message built to attack whoever opens it (see hostileHtmlEml in
 * tests/support/fixtures.mjs), opened in a real browser. The unit tests check
 * the sanitiser's output; this checks what the browser then does with it,
 * which is the part that matters.
 */
const TRACKER = 'https://tracker.example'

/** Record anything the message manages to tell the page it is embedded in. */
async function listenForEscapes(page: Page) {
  await page.addInitScript(() => {
    const w = window as unknown as { __escaped: string[] }
    w.__escaped = []
    window.addEventListener('message', (e) => w.__escaped.push(String(e.data)))
  })
  return () => page.evaluate(() => (window as unknown as { __escaped: string[] }).__escaped)
}

async function openHostile(page: Page) {
  await openFiles(page, fixture('hostile-html.eml'))
  await openMessage(page, 'Hostile markup test')
  await expect(emailFrame(page).locator('#visible')).toBeVisible()
  // Let anything the message would fetch or run have its chance.
  await page.waitForLoadState('networkidle')
}

test('no script in the message runs, by any of the routes it tries', async ({ page }) => {
  const escaped = await listenForEscapes(page)
  const dialogs: string[] = []
  page.on('dialog', (d) => {
    dialogs.push(d.message())
    void d.dismiss()
  })
  await openHostile(page)

  const frame = emailFrame(page)
  await expect(frame.locator('script, iframe, form, object, embed')).toHaveCount(0)
  await expect(frame.locator('[onerror], [onclick], [onload]')).toHaveCount(0)
  // The javascript: link is still text, but it leads nowhere.
  await expect(frame.locator('#js-link')).toHaveText('javascript link')
  await expect(frame.locator('#js-link')).not.toHaveAttribute('href')
  await frame.locator('#js-link').click()

  expect(await escaped()).toEqual([])
  expect(dialogs).toEqual([])
  await expect(page).toHaveTitle('PST Viewer')
})

test('with pictures from the internet allowed, only pictures are fetched, and not the tracking pixel', async ({ page, requests }) => {
  await openHostile(page)

  const fetched = requests.outside.map((u) => u.replace(TRACKER, ''))
  expect(fetched).toContain('/picture.png')
  expect(fetched).not.toContain('/pixel.gif')
  // Nothing but pictures: no frame, no stylesheet (linked or imported), no form target.
  expect(fetched.filter((path) => !path.endsWith('.png'))).toEqual([])
  expect(requests.outside.every((u) => u.startsWith(TRACKER))).toBe(true)

  await expect(emailFrame(page).locator('#remote-image')).toHaveAttribute('src', `${TRACKER}/picture.png`)
  await expect(emailFrame(page).locator('#tracking-pixel')).toHaveCount(0)
})

test('with pictures from the internet off, opening the message contacts nobody', async ({ page, requests }) => {
  await page.goto('./')
  await setSetting(page, 'Load images from the internet', false)
  await openHostile(page)
  expect(requests.outside).toEqual([])

  const frame = emailFrame(page)
  await expect(frame.locator('#remote-image')).not.toHaveAttribute('src')
  // The picture that came inside the message still shows.
  await expect(frame.locator('#inline-image')).toHaveAttribute('src', /^blob:/)
  const loaded = await frame.locator('#inline-image').evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0)
  expect(loaded).toBe(true)
  // And links still work: following one is the reader's choice.
  await expect(frame.locator('#real-link')).toHaveAttribute('href', 'https://example.com/page')
})

test('the setting is remembered the next time the app is opened', async ({ page, requests }) => {
  await page.goto('./')
  await setSetting(page, 'Load images from the internet', false)
  await page.reload()
  await openHostile(page)
  expect(requests.outside).toEqual([])
})

test('a link opens in a new tab, and only when clicked', async ({ page, requests }) => {
  await openHostile(page)
  expect(requests.outside.filter((u) => u.includes('example.com/page'))).toEqual([])
  const popup = page.waitForEvent('popup')
  await emailFrame(page).locator('#real-link').click()
  await expect(await popup).toHaveURL('https://example.com/page')
})

test('a link still opens with pictures from the internet off', async ({ page }) => {
  await page.goto('./')
  await setSetting(page, 'Load images from the internet', false)
  await openHostile(page)
  const popup = page.waitForEvent('popup')
  await emailFrame(page).locator('#real-link').click()
  await expect(await popup).toHaveURL('https://example.com/page')
})

test('a link drawn inside a picture opens like any other', async ({ page }) => {
  await openHostile(page)
  const popup = page.waitForEvent('popup')
  await emailFrame(page).locator('#svg-link').click()
  await expect(await popup).toHaveURL('https://example.com/svg')
})

test('the sender shown is the real one, not the one hidden in the name', async ({ page }) => {
  await openFiles(page, fixture('spoof-sender.eml'))
  await openMessage(page, 'Spoofed sender test')
  const body = page.locator('body')
  await expect(body).toContainText('attacker@evil.example')
  // The name is shown as the text it is, next to the true address.
  await expect(body).toContainText('IT Support <helpdesk@company.example>')
})
