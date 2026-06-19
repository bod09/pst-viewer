import type { MessageContent, RecipientInfo } from '../types'
import { sanitizeEmailHtml } from './sanitizeHtml'
import { formatDate } from './format'

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** Base64 data URL so inline images survive into the printed document. */
function toDataUrl(bytes: ArrayBuffer, mime: string): string {
  const arr = new Uint8Array(bytes)
  let binary = ''
  const chunk = 0x8000
  for (let i = 0; i < arr.length; i += chunk) {
    binary += String.fromCharCode(...arr.subarray(i, i + chunk))
  }
  return `data:${mime || 'application/octet-stream'};base64,${btoa(binary)}`
}

function recipientList(list: RecipientInfo[]): string {
  return list.map((r) => (r.name && r.email ? `${r.name} <${r.email}>` : r.name || r.email)).join('; ')
}

function bodyAndStyles(content: MessageContent): { styles: string; body: string } {
  if (content.html) {
    const cidMap = new Map<string, string>()
    for (const img of content.inlineImages) cidMap.set(img.cid, toDataUrl(img.data, img.mime))
    // Inline images become data URLs; remote images load normally.
    const html = sanitizeEmailHtml(content.html, cidMap)
    const doc = new DOMParser().parseFromString(html, 'text/html')
    const styles = Array.from(doc.querySelectorAll('style'))
      .map((s) => s.textContent ?? '')
      .join('\n')
    return { styles, body: doc.body?.innerHTML ?? '' }
  }
  const text = escapeHtml(content.text ?? '')
  return { styles: '', body: `<pre class="plain">${text}</pre>` }
}

function section(content: MessageContent): string {
  const { styles, body } = bodyAndStyles(content)
  const from = content.fromName || content.fromEmail || '(unknown sender)'
  const fromExtra = content.fromEmail && content.fromName ? ` &lt;${escapeHtml(content.fromEmail)}&gt;` : ''
  const visibleAtt = content.attachments.filter((a) => a.isEmbeddedMessage || !a.isInline)

  const meta = [
    `<div class="meta"><b>From:</b> ${escapeHtml(from)}${fromExtra}</div>`,
    content.to.length ? `<div class="meta"><b>To:</b> ${escapeHtml(recipientList(content.to))}</div>` : '',
    content.cc.length ? `<div class="meta"><b>Cc:</b> ${escapeHtml(recipientList(content.cc))}</div>` : '',
    content.date != null ? `<div class="meta"><b>Date:</b> ${escapeHtml(formatDate(content.date))}</div>` : '',
    visibleAtt.length
      ? `<div class="meta"><b>Attachments:</b> ${escapeHtml(visibleAtt.map((a) => a.name).join(', '))}</div>`
      : '',
  ].join('')

  return `<section class="email">
    <div class="email-header"><h1>${escapeHtml(content.subject)}</h1>${meta}</div>
    ${styles ? `<style>${styles}</style>` : ''}
    <div class="email-body">${body}</div>
  </section>`
}

/** Build a single printable HTML document from one or more emails. */
export function buildPrintDocument(contents: MessageContent[]): string {
  const sections = contents.map(section).join('\n')
  // Empty <title> + `@page { margin: 0 }` make the browser omit its own
  // date/title/URL headers & footers; page padding comes from .email. We do not
  // pin a paper size: the browser's Save-as-PDF dialog already lets the user
  // choose one, defaulting to their locale (Letter in the US, A4 elsewhere). The
  // `!important` html/body reset wins over any sizing rules that leak in from an
  // individual email's own CSS (some set body{height:100%}), which would
  // otherwise force a full-height body and a blank trailing page.
  return `<!doctype html><html><head><meta charset="utf-8"><title></title>
<style>
  @page { margin: 0; }
  html, body { height: auto !important; min-height: 0 !important; margin: 0 !important; padding: 0 !important; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif; color: #111; }
  .email { padding: 14mm; box-sizing: border-box; page-break-after: always; }
  .email:last-child { page-break-after: auto; }
  .email-header { border-bottom: 2px solid #cbd5e1; padding-bottom: 10px; margin-bottom: 16px; }
  .email-header h1 { font-size: 18px; margin: 0 0 8px; }
  .email-header .meta { font-size: 12px; margin: 2px 0; color: #333; }
  .email-body { font-size: 13px; line-height: 1.5; }
  .email-body img { max-width: 100%; height: auto; }
  pre.plain { white-space: pre-wrap; word-wrap: break-word; font-family: inherit; }
  a { color: #0b57d0; }
</style></head>
<body>${sections}</body></html>`
}

/**
 * Print an HTML document via a hidden, full-size, off-screen iframe and the
 * browser's own print engine (highest fidelity; user picks "Save as PDF").
 */
export function printHtmlDocument(html: string): void {
  const iframe = document.createElement('iframe')
  iframe.setAttribute('aria-hidden', 'true')
  Object.assign(iframe.style, {
    position: 'fixed',
    left: '-10000px',
    top: '0',
    width: '794px',
    height: '1123px',
    border: '0',
  })
  document.body.appendChild(iframe)

  // Remove the hidden iframe once, whether the print finishes, is cancelled
  // (onafterprint may never fire then), or never opens. Without the safety
  // timer these can pile up and bog the page down over a session.
  let removed = false
  const remove = () => {
    if (removed) return
    removed = true
    iframe.remove()
  }
  const cleanup = () => setTimeout(remove, 1000)
  const safety = window.setTimeout(remove, 120000)

  let printStarted = false
  let printCap = 0
  const doPrint = () => {
    if (printStarted) return
    printStarted = true
    clearTimeout(printCap)
    const win = iframe.contentWindow
    const doc = iframe.contentDocument
    if (!win) {
      cleanup()
      return
    }
    // Drop any image that has not finished loading. A stalled remote image
    // otherwise keeps Chrome's print preview from ever rendering (so the PDF
    // button appears to do nothing); the ones that loaded still print.
    if (doc) {
      for (const img of Array.from(doc.images || [])) {
        if (!img.complete || img.naturalWidth === 0) img.removeAttribute('src')
      }
    }
    win.onafterprint = () => {
      clearTimeout(safety)
      cleanup()
    }
    try {
      win.focus()
      win.print()
    } catch {
      clearTimeout(safety)
      cleanup()
    }
  }

  // Print shortly after load so images settle, but also print on a cap even if
  // `load` never fires because a remote image is stalling on a slow server.
  iframe.onload = () => window.setTimeout(doPrint, 300)
  printCap = window.setTimeout(doPrint, 4000)

  iframe.srcdoc = html
}
