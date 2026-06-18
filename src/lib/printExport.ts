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
    // Include all images in exports (inline embedded as data URLs, remote allowed).
    const { html } = sanitizeEmailHtml(content.html, cidMap, true)
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
  // date/title/URL headers & footers; page margins come from .email padding.
  return `<!doctype html><html><head><meta charset="utf-8"><title></title>
<style>
  @page { margin: 0; }
  html, body { margin: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif; color: #111; }
  .email { padding: 14mm; page-break-after: always; }
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

  const cleanup = () => setTimeout(() => iframe.remove(), 1000)

  iframe.onload = () => {
    const win = iframe.contentWindow
    if (!win) {
      cleanup()
      return
    }
    win.onafterprint = cleanup
    // Let data-URL images settle before printing.
    setTimeout(() => {
      try {
        win.focus()
        win.print()
      } catch {
        cleanup()
      }
    }, 300)
  }

  iframe.srcdoc = html
}
