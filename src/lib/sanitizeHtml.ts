import DOMPurify from 'dompurify'

// Width/height of 0 or 1 (with optional px) marks an invisible tracking pixel.
const TINY = /^0*[01](?:\.0+)?(?:px)?$/

/** True for a reference the browser would fetch from another server. */
const REMOTE_URL = /^(?:https?:)?\/\//i

/**
 * Sanitize an email's HTML body for safe, faithful rendering inside a
 * sandboxed iframe.
 *  - Strips scripts/objects/forms/event-handlers (XSS-safe).
 *  - Resolves `cid:` image references to local blob: URLs.
 *  - Loads remote images/CSS normally (like a regular mail client), so emails
 *    look exactly as sent, but drops invisible 1x1 / hidden tracking pixels,
 *    which removes the obvious trackers without changing how anything looks.
 *  - With `allowRemote` false, nothing is fetched from another server at all:
 *    remote images, stylesheets and backgrounds are removed, so opening a
 *    message cannot tell the sender it was read.
 */
export function sanitizeEmailHtml(
  rawHtml: string,
  cidUrls: Map<string, string>,
  allowRemote = true,
): string {
  const hook = (node: Element) => {
    const el = node as HTMLElement

    if (el.tagName === 'A') {
      el.setAttribute('target', '_blank')
      el.setAttribute('rel', 'noopener noreferrer nofollow')
    }

    if (!allowRemote) {
      // Anything that would reach another server goes: image sources, CSS
      // links, and url(...) references inside inline styles.
      const src = el.getAttribute('src') ?? ''
      if (REMOTE_URL.test(src)) {
        el.removeAttribute('src')
        el.setAttribute('data-pstv-blocked', '1')
      }
      for (const attr of ['background', 'poster', 'srcset']) {
        if (REMOTE_URL.test(el.getAttribute(attr) ?? '')) el.removeAttribute(attr)
      }
      if (el.tagName === 'LINK' && REMOTE_URL.test(el.getAttribute('href') ?? '')) el.remove()
      const style = el.getAttribute('style')
      if (style && /url\(/i.test(style)) {
        const cleaned = style.replace(/url\(\s*['"]?(?:https?:)?\/\/[^)]*\)/gi, 'none')
        el.setAttribute('style', cleaned)
      }
    }

    if (el.tagName === 'IMG') {
      const src = el.getAttribute('src') ?? ''
      if (/^cid:/i.test(src)) {
        const key = src.slice(4).replace(/^<+|>+$/g, '').trim()
        const url = cidUrls.get(key)
        if (url) el.setAttribute('src', url)
        else el.removeAttribute('src')
      }

      // Drop invisible tracking pixels (zero/one px, or hidden). This keeps the
      // visible content identical while pinging fewer trackers.
      const tiny = (v: string | null) => v != null && TINY.test(v.trim())
      const style = (el.getAttribute('style') ?? '').toLowerCase()
      const hidden =
        /display\s*:\s*none|visibility\s*:\s*hidden|(?:width|height)\s*:\s*0(?:px)?\b/.test(style)
      if (tiny(el.getAttribute('width')) || tiny(el.getAttribute('height')) || hidden) {
        el.remove()
      }
    }
  }

  DOMPurify.addHook('afterSanitizeAttributes', hook)
  const html = DOMPurify.sanitize(rawHtml, {
    WHOLE_DOCUMENT: true,
    FORBID_TAGS: ['script', 'noscript', 'iframe', 'object', 'embed', 'form', 'base'],
    FORBID_ATTR: ['ping'],
    ADD_ATTR: ['target'],
  })
  DOMPurify.removeHook('afterSanitizeAttributes')

  return html
}
