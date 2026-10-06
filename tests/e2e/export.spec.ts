import PostalMime from 'postal-mime'
import { type Page } from '@playwright/test'
import { readMboxrd } from '../support/mboxrd'
import { expect, fixture, folderRow, messageRow, openFiles, openMessage, reader, test } from './support'

/**
 * Exporting writes to a folder the reader picks. A test cannot click through
 * the browser's own folder picker, so the picker is replaced with one that
 * hands back a folder in the browser's private storage: the same kind of
 * handle, written through the same API, and readable afterwards.
 */
async function pickPrivateFolder(page: Page) {
  await page.addInitScript(() => {
    const w = window as unknown as { showDirectoryPicker: () => Promise<FileSystemDirectoryHandle> }
    w.showDirectoryPicker = async () =>
      (await navigator.storage.getDirectory()).getDirectoryHandle('picked', { create: true })
  })
}

/** Everything the export wrote, as path to text. */
async function written(page: Page): Promise<Record<string, string>> {
  return page.evaluate(async () => {
    const out: Record<string, string> = {}
    type Dir = FileSystemDirectoryHandle & { entries(): AsyncIterable<[string, FileSystemHandle]> }
    const walk = async (dir: FileSystemDirectoryHandle, prefix: string) => {
      for await (const [name, handle] of (dir as Dir).entries()) {
        if (handle.kind === 'directory') await walk(handle as FileSystemDirectoryHandle, `${prefix}${name}/`)
        else out[`${prefix}${name}`] = await (await (handle as FileSystemFileHandle).getFile()).text()
      }
    }
    const root = await navigator.storage.getDirectory()
    await walk(await root.getDirectoryHandle('picked', { create: true }), '')
    return out
  })
}

const exportDialog = (page: Page) => page.getByRole('dialog').filter({ hasText: /Export/ })

async function openThree(page: Page) {
  await openFiles(page, fixture('mail.eml'), fixture('forwarded.eml'), fixture('mail.msg'))
  await expect(messageRow(page, 'Quarterly zebra report')).toBeVisible()
}

test.describe('exporting to a folder', () => {
  test.beforeEach(async ({ page }) => pickPrivateFolder(page))

  test('a folder is saved as one .eml per message, named by date and subject', async ({ page }) => {
    await openThree(page)
    await folderRow(page, 'Messages').getByRole('button', { name: 'Export Messages as .eml files' }).click()
    await expect(exportDialog(page).getByRole('status')).toContainText('Saved 3 messages as .eml files into Messages')

    const files = await written(page)
    // Times are local to the reader (the tests run in Tokyo, nine hours ahead of the +0000 in the mail).
    expect(Object.keys(files).sort()).toEqual([
      'Messages/2024-03-12 1915 Quarterly zebra report.eml',
      'Messages/2024-03-12 2100 Fwd_ Original walrus memo.eml',
      'Messages/Distinctive msg subject wombat.eml',
    ])
    const zebra = await PostalMime.parse(files['Messages/2024-03-12 1915 Quarterly zebra report.eml'])
    expect(zebra.subject).toBe('Quarterly zebra report')
    expect(zebra.from?.address).toBe('alice@example.com')
    expect(zebra.attachments.map((a) => a.filename)).toEqual(['chart.png'])
  })

  test('a whole mailbox keeps its folders', async ({ page }) => {
    await openThree(page)
    await page.getByRole('button', { name: /^Export Messages \(3\) as \.eml files$/ }).click()
    await expect(exportDialog(page).getByRole('status')).toContainText('Saved 3 messages')
    const paths = Object.keys(await written(page))
    expect(paths).toHaveLength(3)
    expect(paths.every((p) => /^Messages \(3\)\/Messages\/[^/]+\.eml$/.test(p))).toBe(true)
  })

  test('pressing E on a folder exports it', async ({ page }) => {
    await openThree(page)
    await folderRow(page, 'Messages').focus()
    await page.keyboard.press('e')
    await expect(exportDialog(page).getByRole('status')).toContainText('Saved 3 messages')
  })

  test('only the ticked messages are saved', async ({ page }) => {
    await openThree(page)
    await messageRow(page, 'Quarterly zebra report').getByRole('checkbox').check()
    await messageRow(page, 'Distinctive msg subject wombat').getByRole('checkbox').check()
    await expect(page.getByText('2 messages selected')).toBeVisible()
    await page.getByRole('button', { name: 'Export EML' }).click()
    await expect(exportDialog(page).getByRole('status')).toContainText('Saved 2 messages')
    const names = Object.keys(await written(page)).map((p) => p.split('/').pop())
    expect(names.sort()).toEqual(['2024-03-12 1915 Quarterly zebra report.eml', 'Distinctive msg subject wombat.eml'])
  })

  test('exporting twice never writes over the first export', async ({ page }) => {
    await openThree(page)
    const button = folderRow(page, 'Messages').getByRole('button', { name: 'Export Messages as .eml files' })
    await button.click()
    await expect(exportDialog(page).getByRole('status')).toContainText('into Messages,')
    await exportDialog(page).getByRole('button', { name: 'Close' }).click()
    await button.click()
    await expect(exportDialog(page).getByRole('status')).toContainText('into Messages (2),')
    const paths = Object.keys(await written(page))
    expect(paths.filter((p) => p.startsWith('Messages/'))).toHaveLength(3)
    expect(paths.filter((p) => p.startsWith('Messages (2)/'))).toHaveLength(3)
  })

  test('nothing but finished .eml files is left in the folder', async ({ page }) => {
    await openThree(page)
    await folderRow(page, 'Messages').getByRole('button', { name: 'Export Messages as .eml files' }).click()
    await expect(exportDialog(page).getByRole('status')).toContainText('Saved 3 messages')
    const files = await written(page)
    expect(Object.keys(files).every((p) => p.endsWith('.eml'))).toBe(true)
    expect(Object.values(files).every((text) => text.length > 100)).toBe(true)
  })
})

test.describe('exporting to .mbox files', () => {
  test.beforeEach(async ({ page }) => pickPrivateFolder(page))

  test('a folder is saved as one .mbox file holding every message', async ({ page }) => {
    await openThree(page)
    await folderRow(page, 'Messages').getByRole('button', { name: 'Export Messages as .mbox files' }).click()
    await expect(exportDialog(page).getByRole('status')).toContainText(
      'Saved 3 messages to .mbox files (one per folder) into Messages,',
    )
    const files = await written(page)
    expect(Object.keys(files)).toEqual(['Messages/Messages.mbox'])
    const messages = readMboxrd(files['Messages/Messages.mbox'])
    expect(messages.map((m) => m.separator)).toEqual([
      'From MAILER-DAEMON Tue Mar 12 10:15:00 2024',
      'From MAILER-DAEMON Tue Mar 12 12:00:00 2024',
      expect.stringMatching(/^From MAILER-DAEMON /),
    ])
    const parsed = await Promise.all(messages.map((m) => PostalMime.parse(m.message)))
    expect(parsed.map((e) => e.subject)).toEqual([
      'Quarterly zebra report',
      'Fwd: Original walrus memo',
      'Distinctive msg subject wombat',
    ])
    expect(parsed[0].attachments.map((a) => a.filename)).toEqual(['chart.png'])
  })

  test('a whole mailbox keeps its folders, one file each', async ({ page }) => {
    await openThree(page)
    await page.getByRole('button', { name: /^Export Messages \(3\) as \.mbox files$/ }).click()
    await expect(exportDialog(page).getByRole('status')).toContainText('Saved 3 messages')
    const files = await written(page)
    expect(Object.keys(files)).toEqual(['Messages (3)/Messages.mbox'])
    expect(readMboxrd(files['Messages (3)/Messages.mbox'])).toHaveLength(3)
  })

  test('pressing M on a folder exports it as .mbox', async ({ page }) => {
    await openThree(page)
    await folderRow(page, 'Messages').focus()
    await page.keyboard.press('m')
    await expect(exportDialog(page).getByRole('status')).toContainText('to .mbox files')
  })

  test('only the ticked messages are saved, in their folder\'s file', async ({ page }) => {
    await openThree(page)
    await messageRow(page, 'Quarterly zebra report').getByRole('checkbox').check()
    await messageRow(page, 'Distinctive msg subject wombat').getByRole('checkbox').check()
    await page.getByRole('button', { name: 'Export MBOX' }).click()
    await expect(exportDialog(page).getByRole('status')).toContainText('Saved 2 messages')
    const files = await written(page)
    expect(Object.keys(files)).toEqual(['Selected messages/Messages.mbox'])
    const subjects = await Promise.all(
      readMboxrd(files['Selected messages/Messages.mbox']).map(async (m) => (await PostalMime.parse(m.message)).subject),
    )
    expect(subjects).toEqual(['Quarterly zebra report', 'Distinctive msg subject wombat'])
  })

  test('exporting twice never writes over the first export', async ({ page }) => {
    await openThree(page)
    const button = folderRow(page, 'Messages').getByRole('button', { name: 'Export Messages as .mbox files' })
    await button.click()
    await expect(exportDialog(page).getByRole('status')).toContainText('into Messages,')
    await exportDialog(page).getByRole('button', { name: 'Close' }).first().click()
    await button.click()
    await expect(exportDialog(page).getByRole('status')).toContainText('into Messages (2),')
    expect(Object.keys(await written(page)).sort()).toEqual(['Messages (2)/Messages.mbox', 'Messages/Messages.mbox'])
  })
})

test('closing the folder picker without choosing starts nothing', async ({ page }) => {
  await page.addInitScript(() => {
    const w = window as unknown as { showDirectoryPicker: () => Promise<never> }
    w.showDirectoryPicker = () => Promise.reject(new DOMException('The user aborted a request.', 'AbortError'))
  })
  await openThree(page)
  await folderRow(page, 'Messages').getByRole('button', { name: 'Export Messages as .eml files' }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(messageRow(page, 'Quarterly zebra report')).toBeVisible()
})

test('a browser that cannot write to a folder is told so, with what still works', async ({ page }) => {
  await page.addInitScript(() => {
    delete (window as unknown as { showDirectoryPicker?: unknown }).showDirectoryPicker
  })
  await openThree(page)
  await folderRow(page, 'Messages').getByRole('button', { name: 'Export Messages as .eml files' }).click()
  await expect(page.getByRole('dialog')).toContainText('needs a Chromium-based browser')
  await expect(page.getByRole('dialog')).toContainText('Single messages can still be saved one at a time')
})

test('the .mbox export tells such a browser the same', async ({ page }) => {
  await page.addInitScript(() => {
    delete (window as unknown as { showDirectoryPicker?: unknown }).showDirectoryPicker
  })
  await openThree(page)
  await folderRow(page, 'Messages').getByRole('button', { name: 'Export Messages as .mbox files' }).click()
  await expect(page.getByRole('dialog', { name: 'Export as .mbox files' })).toContainText('needs a Chromium-based browser')
})

test.describe('saving one message', () => {
  test('the EML button downloads the message, attachment and all', async ({ page }) => {
    await openThree(page)
    await openMessage(page, 'Quarterly zebra report')
    const downloading = page.waitForEvent('download')
    await reader(page).getByRole('button', { name: 'EML', exact: true }).click()
    const download = await downloading
    expect(download.suggestedFilename()).toBe('Quarterly_zebra_report.eml')
    const chunks: Buffer[] = []
    for await (const chunk of await download.createReadStream()) chunks.push(chunk as Buffer)
    const email = await PostalMime.parse(Buffer.concat(chunks))
    expect(email.subject).toBe('Quarterly zebra report')
    expect(email.text).toContain('pomegranate')
    expect(email.attachments.map((a) => [a.filename, a.mimeType])).toEqual([['chart.png', 'image/png']])
  })

  test('the PDF button prints from a frame that cannot run script', async ({ page }) => {
    // Printing itself belongs to the browser; what is ours is the page handed to it.
    await page.addInitScript(() => {
      window.print = () => {}
    })
    await openFiles(page, fixture('hostile-html.eml'))
    await openMessage(page, 'Hostile markup test')
    await reader(page).getByRole('button', { name: 'PDF', exact: true }).click()
    const printFrame = page.locator('iframe[aria-hidden="true"]')
    await expect(printFrame).toHaveCount(1)
    expect((await printFrame.getAttribute('sandbox'))?.split(/\s+/).sort()).toEqual(['allow-modals', 'allow-same-origin'])
    const printed = page.frameLocator('iframe[aria-hidden="true"]')
    await expect(printed.locator('h1')).toHaveText('Hostile markup test')
    await expect(printed.locator('#visible')).toHaveText('Visible paragraph: kumquat.')
    await expect(printed.locator('script, iframe, form')).toHaveCount(0)
  })
})
