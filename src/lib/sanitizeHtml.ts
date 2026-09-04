import DOMPurify from 'dompurify'

// Width/height of 0 or 1 (with optional px) marks an invisible tracking pixel.
const TINY = /^0*[01](?:\.0+)?(?:px)?$/

/** True for a reference the browser would fetch from another server. The
 *  value is stripped of tabs and newlines first, because the URL parser
 *  ignores those and would still fetch "ht\ttp://host". */
const REMOTE_URL = /^(?:https?:)?\/\//i
const isRemote = (value: string | null): boolean =>
  !!value && REMOTE_URL.test(value.replace(/[\t\n\r]/g, '').trim())

/** Attributes that can name a remote resource, across HTML and SVG. */
const URL_ATTRS = ['src', 'href', 'xlink:href', 'background', 'poster', 'action', 'data', 'formaction']

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
      // A <style> element's contents are never inspected by the hook, and CSS
      // has many ways to fetch (url(), @import, @font-face, image-set), so the
      // whole element goes rather than trying to rewrite the stylesheet.
      if (el.tagName === 'STYLE') {
        el.remove()
        return
      }
      // Any attribute that could name a remote resource, not a fixed list:
      // SVG uses href/xlink:href where HTML uses src.
      for (const attr of URL_ATTRS) {
        if (isRemote(el.getAttribute(attr))) {
          el.removeAttribute(attr)
          if (el.tagName === 'IMG') el.setAttribute('data-pstv-blocked', '1')
        }
      }
      // srcset holds several candidates; a remote one may follow a local one.
      const srcset = el.getAttribute('srcset')
      if (srcset) {
        const kept = srcset
          .split(',')
          .filter((c) => !isRemote(c.trim().split(/\s+/)[0] ?? ''))
          .join(',')
        if (kept.trim()) el.setAttribute('srcset', kept)
        else el.removeAttribute('srcset')
      }
      // Inline styles can fetch through url() and image-set(), and the URL may
      // be CSS-escaped, so drop the whole declaration rather than pattern-match
      // the address.
      const style = el.getAttribute('style')
      if (style && /url\(|image-set\(/i.test(style)) {
        el.setAttribute(
          'style',
          style.replace(/(?:url|image-set)\([^)]*\)/gi, 'none'),
        )
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
  let html: string
  try {
    html = DOMPurify.sanitize(rawHtml, {
      WHOLE_DOCUMENT: true,
      FORBID_TAGS: ['script', 'noscript', 'iframe', 'object', 'embed', 'form', 'base'],
      FORBID_ATTR: ['ping'],
      ADD_ATTR: ['target'],
    })
  } finally {
    // Always unhook: a hook left installed would carry this call's settings
    // into every later message, including ones that must block.
    DOMPurify.removeHook('afterSanitizeAttributes')
  }

  // Belt and braces: even if something slips past the hook, this policy stops
  // the frame reaching another server at all. Inline styles and data/blob
  // images (the message's own pictures) still work.
  if (!allowRemote) {
    const csp =
      '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; ' +
      'img-src data: blob:; style-src \'unsafe-inline\'; font-src data:">'
    html = /<head[^>]*>/i.test(html)
      ? html.replace(/<head[^>]*>/i, (m) => m + csp)
      : csp + html
  }

  return html
}
