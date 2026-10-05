import { emailFrame, expect, fixture, folderRow, messageList, messageRow, openFiles, openMessage, publicMailboxPath, reader, test, upload } from './support'

test.describe('the start page', () => {
  test('says what to do, and loads nothing from anywhere else', async ({ page, requests }) => {
    await page.goto('./')
    await expect(page.getByRole('heading', { name: 'Open your mailbox' })).toBeVisible()
    await expect(page.getByRole('button', { name: /Browse files/ })).toBeVisible()
    await expect(page).toHaveTitle('PST Viewer')
    await page.waitForLoadState('networkidle')
    expect(requests.outside).toEqual([])
    // Nothing failed to load either: a missing file is a broken build.
    const failed = (await Promise.all(requests.all.map(async (r) => [r.url(), (await r.response())?.status()] as const))).filter(
      ([, status]) => status === undefined || status >= 400,
    )
    expect(failed).toEqual([])
  })

  test('carries a policy that forbids inline script and talking to other servers', async ({ page }) => {
    // The last line of defence if a message's markup ever got past the
    // sanitiser and the sandbox: the page itself will not run it.
    await page.goto('./')
    const policy = await page.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute('content')
    const directive = (name: string) => policy?.split(';').map((d) => d.trim()).find((d) => d.startsWith(`${name} `)) ?? ''
    expect(directive('script-src')).toBe("script-src 'self' 'wasm-unsafe-eval'")
    expect(directive('connect-src')).toBe("connect-src 'self'")
    expect(directive('default-src')).toBe("default-src 'self'")
    expect(directive('object-src')).toBe("object-src 'none'")
    expect(directive('form-action')).toBe("form-action 'none'")
    // And the browser enforces it: an inline script added to the page does not run.
    const ran = await page.evaluate(() => {
      const script = document.createElement('script')
      script.textContent = 'window.__inlineRan = true'
      document.head.appendChild(script)
      return Boolean((window as unknown as { __inlineRan?: boolean }).__inlineRan)
    })
    expect(ran).toBe(false)
  })

  test('raises no errors in the console', async ({ page }) => {
    const errors: string[] = []
    page.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
    page.on('pageerror', (e) => errors.push(e.message))
    await page.goto('./')
    await openFiles(page, fixture('mail.eml'))
    await openMessage(page, 'Quarterly zebra report')
    expect(errors).toEqual([])
  })
})

test.describe('opening files', () => {
  test('an .eml shows its folder, the message, and what is attached', async ({ page }) => {
    await openFiles(page, fixture('mail.eml'))
    await expect(folderRow(page, 'Messages')).toBeVisible()
    await expect(messageList(page).getByRole('option')).toHaveCount(1)
    await expect(messageRow(page, 'Quarterly zebra report')).toContainText('Alice Example')

    await openMessage(page, 'Quarterly zebra report')
    await expect(reader(page)).toContainText('Alice Example')
    await expect(reader(page)).toContainText('alice@example.com')
    await expect(reader(page)).toContainText('Bob Tester')
    await expect(reader(page)).toContainText('Distinctive keyword: pomegranate.')
    await expect(reader(page).getByRole('button', { name: /chart\.png/ })).toBeVisible()
  })

  test('a .msg opens the same way', async ({ page }) => {
    await openFiles(page, fixture('mail.msg'))
    await openMessage(page, 'Distinctive msg subject wombat')
    await expect(reader(page)).toContainText('Carol Sender')
    await expect(reader(page)).toContainText('Body of the msg file.')
  })

  test('a zip is searched for the mail inside it', async ({ page }) => {
    await openFiles(page, fixture('batch.zip'))
    await expect(messageList(page).getByRole('option')).toHaveCount(2)
    await expect(messageRow(page, 'Quarterly zebra report')).toBeVisible()
    await expect(messageRow(page, 'Distinctive msg subject wombat')).toBeVisible()
  })

  test('several files at once become one list', async ({ page }) => {
    await openFiles(page, fixture('mail.eml'), fixture('spoof-sender.eml'), fixture('forwarded.eml'), fixture('mail.msg'))
    await expect(messageList(page).getByRole('option')).toHaveCount(4)
  })

  test('an html message is shown in a frame that cannot run script', async ({ page }) => {
    await openFiles(page, fixture('hostile-html.eml'))
    await openMessage(page, 'Hostile markup test')
    await expect(emailFrame(page).locator('#visible')).toHaveText('Visible paragraph: kumquat.')
    const sandbox = await page.locator('iframe[title="Email content"]').getAttribute('sandbox')
    expect(sandbox?.split(/\s+/)).not.toContain('allow-scripts')
  })

  test('a message attached to a message opens from its chip', async ({ page }) => {
    await openFiles(page, fixture('forwarded.eml'))
    await openMessage(page, 'Fwd: Original walrus memo')
    await reader(page).getByRole('button', { name: /Original walrus memo/ }).click()
    await expect(page.getByText('Inner body. Distinctive keyword: persimmon.')).toBeVisible()
    await expect(page.getByText('Dave Inner').first()).toBeVisible()
  })

  test('a file that is not mail is reported, not shown as an empty mailbox', async ({ page }) => {
    await openFiles(page, upload('broken.eml', 'this is not a message'))
    await expect(page.getByText('This file could not be opened as an email message.')).toBeVisible()
    await expect(messageList(page)).toHaveCount(0)
  })

  test('a zip with no mail in it says what it did find', async ({ page }) => {
    const { zip } = await import('../support/fixtures.mjs')
    await openFiles(page, upload('holiday.zip', zip({ 'photo.jpg': new Uint8Array([1, 2, 3]), 'notes.txt': new Uint8Array([4]) })))
    await expect(page.getByText(/No PST, OST, MSG, or EML files found in this zip\./)).toBeVisible()
    await expect(page.getByText(/photo\.jpg/)).toBeVisible()
  })

  test('a mailbox can be closed again', async ({ page }) => {
    await openFiles(page, fixture('mail.eml'))
    await expect(messageRow(page, 'Quarterly zebra report')).toBeVisible()
    await page.getByRole('button', { name: /^Remove / }).click()
    await expect(page.getByRole('heading', { name: 'Open your mailbox' })).toBeVisible()
  })
})

test.describe('a real .pst', () => {
  test('opens with its folders, and a message in it can be read', async ({ page }) => {
    await openFiles(page, publicMailboxPath('enron.pst'))
    // Folders appear once the file has been read; the first with mail is selected.
    await expect(page.getByRole('treeitem').first()).toBeVisible()
    expect(await page.getByRole('treeitem').count()).toBeGreaterThan(3)
    await expect(messageList(page).getByRole('option').first()).toBeVisible()
    await messageList(page).getByRole('option').first().getByRole('button').click()
    await expect(reader(page).getByRole('heading').first()).toBeVisible()
    await expect(reader(page)).toContainText('From')
  })

  test('mail kept in the top folder itself has a row, and it is the one shown first', async ({ page }) => {
    await openFiles(page, publicMailboxPath('alpha-beta-gamma-delta.pst'))
    const rows = page.getByRole('treeitem')
    await expect(rows).toHaveCount(1)
    await expect(rows.first()).toHaveAttribute('aria-selected', 'true')
    await expect(messageList(page).getByRole('option')).toHaveCount(1)
  })
})
