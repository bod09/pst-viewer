import { expect, test } from '@playwright/test'
import { fixture, openFiles, openMessage, reader, watchRequests } from './support'

// The same app, built to be served from /pst-viewer/ as GitHub Pages serves
// it. Everything it loads has to come from under that path.
test('served from a subpath, the app loads everything from under it and works', async ({ page, baseURL }) => {
  const requests = await watchRequests(page)
  await page.goto('./')
  await expect(page.getByRole('heading', { name: 'Open your mailbox' })).toBeVisible()
  await openFiles(page, fixture('mail.eml'))
  await openMessage(page, 'Quarterly zebra report')
  await expect(reader(page)).toContainText('Distinctive keyword: pomegranate.')
  await page.waitForLoadState('networkidle')

  const base = new URL(baseURL!)
  expect(base.pathname).toBe('/pst-viewer/')
  const responses = await Promise.all(requests.all.map(async (r) => ({ url: new URL(r.url()), status: (await r.response())?.status() })))
  const served = responses.filter((r) => r.url.protocol === 'http:')
  expect(served.length).toBeGreaterThan(3)
  expect(served.filter((r) => !r.url.pathname.startsWith('/pst-viewer/')).map((r) => r.url.pathname)).toEqual([])
  expect(served.filter((r) => r.status === undefined || r.status >= 400).map((r) => r.url.pathname)).toEqual([])
  expect(served.map((r) => r.url.pathname)).toContain('/pst-viewer/branding.json')
  expect(requests.outside).toEqual([])
})
