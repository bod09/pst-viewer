import { expect, test } from './support'
import { type Page } from '@playwright/test'

/** Serve this as the deployment's branding.json. */
async function brand(page: Page, body: string | Record<string, unknown>) {
  await page.route('**/branding.json', (route) =>
    route.fulfill({ contentType: 'application/json', body: typeof body === 'string' ? body : JSON.stringify(body) }),
  )
}

const LOGO =
  'data:image/svg+xml;utf8,' +
  encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 40"><rect width="120" height="40" fill="#f60"/></svg>')

test('a deployment can change the name, tagline, logo and colour with one file', async ({ page }) => {
  await brand(page, { name: 'Acme Mail', tagline: 'Internal use only', logo: LOGO, logoSize: 40, accent: '#ff6600' })
  await page.goto('./')
  await expect(page).toHaveTitle('Acme Mail')
  await expect(page.getByText('Acme Mail')).toBeVisible()
  await expect(page.getByText('Internal use only')).toBeVisible()
  const logo = page.locator('img[src^="data:image/svg+xml"]')
  await expect(logo).toBeVisible()
  expect((await logo.boundingBox())?.height).toBe(40)
  const accent = await page.evaluate(() => document.documentElement.style.getPropertyValue('--color-sky-500'))
  expect(accent).toBe('#ff6600')
})

test('a logo size outside what the header can show is brought back inside it', async ({ page }) => {
  await brand(page, { logo: LOGO, logoSize: 500 })
  await page.goto('./')
  const logo = page.locator('img[src^="data:image/svg+xml"]')
  await expect(logo).toBeVisible()
  expect((await logo.boundingBox())?.height).toBe(44)
})

test('a broken branding file leaves the app as it is', async ({ page }) => {
  await brand(page, '{ "name": "Half a file')
  await page.goto('./')
  await expect(page).toHaveTitle('PST Viewer')
  await expect(page.getByText('Local · Offline · Private')).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Open your mailbox' })).toBeVisible()
})

test('markup in a branding value is shown as text', async ({ page }) => {
  await brand(page, { name: '<img src=x onerror=document.title="pwned">', tagline: '<script>document.title="pwned"</script>' })
  await page.goto('./')
  await expect(page.getByText('<img src=x onerror=document.title="pwned">')).toBeVisible()
  await expect(page).toHaveTitle('<img src=x onerror=document.title="pwned">')
})

test('the reader\'s own accent colour wins and is remembered', async ({ page }) => {
  await brand(page, { accent: '#ff6600' })
  await page.goto('./')
  await page.getByRole('button', { name: 'Settings' }).click()
  await page.getByRole('button', { name: 'Accent: #0d9488' }).click()
  const accent = () => page.evaluate(() => document.documentElement.style.getPropertyValue('--color-sky-500'))
  expect(await accent()).toBe('#0d9488')
  await page.reload()
  await expect(page.getByRole('heading', { name: 'Open your mailbox' })).toBeVisible()
  expect(await accent()).toBe('#0d9488')
})
