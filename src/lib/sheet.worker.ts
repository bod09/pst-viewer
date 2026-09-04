/**
 * Spreadsheet parsing, off the main thread.
 *
 * The parser (SheetJS 0.18.5, the last version published to npm) has known
 * prototype-pollution and denial-of-service issues with no fixed release
 * available there, and it runs on bytes that came out of someone's mailbox.
 * In a worker both are contained: a polluted prototype belongs to this
 * throwaway realm rather than the app's, and a parse that will not terminate
 * costs a worker rather than freezing the window. The HTML returned here is
 * still untrusted and is sanitised by the caller before it is rendered.
 */

export interface SheetResult {
  sheets: string[]
  /** Raw table markup per sheet, in the same order. Sanitise before use. */
  tables: string[]
}

self.onmessage = async (e: MessageEvent<ArrayBuffer>) => {
  try {
    const XLSX = await import('xlsx')
    const wb = XLSX.read(new Uint8Array(e.data), { type: 'array' })
    const sheets = wb.SheetNames
    const tables = sheets.map((name) => {
      const sheet = wb.Sheets[name]
      return sheet ? XLSX.utils.sheet_to_html(sheet) : ''
    })
    self.postMessage({ ok: true, result: { sheets, tables } satisfies SheetResult })
  } catch {
    self.postMessage({ ok: false })
  }
}
