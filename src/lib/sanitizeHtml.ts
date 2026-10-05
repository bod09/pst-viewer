import DOMPurify from 'dompurify'

// Width/height of 0 or 1 (with optional px) marks an invisible tracking pixel.
const TINY = /^0*[01](?:\.0+)?(?:px)?$/

/**
 * True for a reference the browser would fetch from another server.
 *
 * Decided by the URL parser, not by pattern: it is what the browser will use,
 * and it accepts spellings a pattern misses (`https:\\host`, `\\host`, `/\host`,
 * a tab inside the scheme, control characters in front). Anything that does
 * not resolve to this page, or to data kept in the page, is remote.
 */
const HERE = 'https://here.invalid'
const LOCAL_SCHEMES = new Set(['data:', 'blob:', 'cid:', 'about:', 'mailto:', 'tel:'])
function isRemote(value: string | null): boolean {
  if (!value) return false
  try {
    const url = new URL(value, `${HERE}/`)
    return url.origin !== HERE && !LOCAL_SCHEMES.has(url.protocol)
  } catch {
    // Not a URL the browser could fetch.
    return false
  }
}

/** The CSS that can make a browser fetch something: url(), image-set() and
 *  their relatives, or any escape, which could be spelling one of those. */
const CSS_FETCH = /\\|(?:url|image-set|image|cross-fade|element)\(/i

/** The page-wide policy for a message shown with remote content off. */
export const NO_REMOTE_POLICY =
  '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; ' +
  'img-src data: blob:; style-src \'unsafe-inline\'; font-src data:">'

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
    // By local name, which is the same for HTML and SVG links (an SVG <a> has
    // a lower-case tagName).
    const isLink = el.localName === 'a' || el.localName === 'area'

    if (isLink) {
      el.setAttribute('target', '_blank')
      el.setAttribute('rel', 'noopener noreferrer nofollow')
    }

    if (!allowRemote) {
      // A <style> element's contents are never inspected by the hook, and CSS
      // has many ways to fetch (url(), @import, @font-face, image-set), so the
      // whole element goes rather than trying to rewrite the stylesheet.
      // By local name: a <style> inside inline SVG is in the SVG namespace
      // (lower-case tagName) and styles the whole page just the same.
      if (el.localName === 'style') {
        el.remove()
        return
      }
      // Any attribute that could name a remote resource, not a fixed list:
      // SVG uses href/xlink:href where HTML uses src.
      for (const attr of URL_ATTRS) {
        // Where a link leads is not fetched by showing the message, only when
        // the reader chooses to follow it, so links keep their address.
        if (isLink && (attr === 'href' || attr === 'xlink:href')) continue
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
      // SVG takes CSS values in ordinary attributes (fill, filter, mask and
      // so on), where url() fetches just as it does in a style. A reference
      // to something in the same picture, url(#id), is not a fetch.
      if (el.namespaceURI !== 'http://www.w3.org/1999/xhtml') {
        for (const attr of Array.from(el.attributes)) {
          if (attr.name === 'style') continue
          const elsewhere = attr.value.replace(/url\(\s*['"]?#[^)\\]*\)/gi, '')
          if (CSS_FETCH.test(elsewhere)) el.removeAttribute(attr.name)
        }
      }
      // Inline styles can fetch too. Each declaration that could is dropped
      // whole, rather than trying to cut the address out of it: the address
      // may be escaped, quoted, or never closed.
      const style = el.getAttribute('style')
      if (style && CSS_FETCH.test(style)) {
        const kept = style.split(';').filter((declaration) => !CSS_FETCH.test(declaration))
        if (kept.join('').trim()) el.setAttribute('style', kept.join(';'))
        else el.removeAttribute('style')
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
      //
      // Only images fetched from another server are worth removing: one
      // carried inside the message cannot report anything, and removing it
      // would renumber the pictures the reader points at when a search
      // matches text inside one.
      if (isRemote(el.getAttribute('src'))) {
        const tiny = (v: string | null) => v != null && TINY.test(v.trim())
        const style = (el.getAttribute('style') ?? '').toLowerCase()
        const hidden =
          /display\s*:\s*none|visibility\s*:\s*hidden|(?:width|height)\s*:\s*0(?:px)?\b/.test(style)
        if (tiny(el.getAttribute('width')) || tiny(el.getAttribute('height')) || hidden) {
          el.remove()
        }
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
  // images (the message's own pictures) still work. It goes in front of
  // everything, where the parser puts it in the head whatever follows; looking
  // for the message's own <head> to put it in could be fooled by an attribute
  // containing one.
  if (!allowRemote) html = NO_REMOTE_POLICY + html

  return html
}
