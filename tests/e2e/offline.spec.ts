import { expect, test } from '@playwright/test'
import { fixture, messageRow, openFiles, openMessage, reader } from './support'

// The service worker is what makes the app work with no connection, so this
// is the one place it is allowed to install (see playwright.config.ts).
test.use({ serviceWorkers: 'allow' })

test('once loaded, the app opens and reads mail with no connection at all', async ({ page, context }) => {
  await page.goto('./')
  // Wait until the service worker has everything stored and is in charge of the page.
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready
    if (!navigator.serviceWorker.controller) {
      await new Promise((resolve) => navigator.serviceWorker.addEventListener('controllerchange', resolve, { once: true }))
    }
  })

  await context.setOffline(true)
  await page.reload()
  await expect(page.getByRole('heading', { name: 'Open your mailbox' })).toBeVisible()

  // Reading a message needs the worker script and the parsers, none of which
  // had been used before the connection went.
  await openFiles(page, fixture('mail.eml'), fixture('mail.msg'))
  await expect(messageRow(page, 'Distinctive msg subject wombat')).toBeVisible()
  await openMessage(page, 'Quarterly zebra report')
  await expect(reader(page)).toContainText('Distinctive keyword: pomegranate.')
})
