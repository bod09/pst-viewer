import DOMPurify from 'dompurify'

export interface SanitizeResult {
  html: string
  /** True if any remote (http/https) image or CSS resource was blocked. */
  blockedRemote: boolean
}

const REMOTE_RE = /^https?:\/\//i

/**
 * Sanitize an email's HTML body for safe, faithful rendering inside a
 * sandboxed iframe.
 *  - Strips scripts/objects/forms (XSS-safe).
 *  - Resolves `cid:` image references to local blob: URLs.
 *  - Blocks remote images/CSS by default (tracking-pixel protection); the
 *    caller can re-run with `allowRemote = true` to load them.
 */
export function sanitizeEmailHtml(
  rawHtml: string,
  cidUrls: Map<string, string>,
  allowRemote: boolean,
): SanitizeResult {
  let blockedRemote = false

  const hook = (node: Element) => {
    const el = node as HTMLElement

    if (el.tagName === 'A') {
      el.setAttribute('target', '_blank')
      el.setAttribute('rel', 'noopener noreferrer nofollow')
    }

    if (el.tagName === 'IMG') {
      const src = el.getAttribute('src') ?? ''
      if (/^cid:/i.test(src)) {
        const key = src.slice(4).replace(/^<+|>+$/g, '').trim()
        const url = cidUrls.get(key)
        if (url) el.setAttribute('src', url)
        else el.removeAttribute('src')
      } else if (REMOTE_RE.test(src)) {
        if (!allowRemote) {
          blockedRemote = true
          el.removeAttribute('src')
          el.setAttribute('data-blocked-src', src)
        }
      } else if (!/^data:/i.test(src)) {
        el.removeAttribute('src')
      }
      if (el.hasAttribute('srcset') && !allowRemote) {
        blockedRemote = true
        el.removeAttribute('srcset')
      }
    }

    const style = el.getAttribute('style')
    if (style && !allowRemote && /url\(\s*['"]?https?:/i.test(style)) {
      blockedRemote = true
      el.setAttribute('style', style.replace(/url\(\s*['"]?https?:[^)]*\)/gi, 'none'))
    }
  }

  DOMPurify.addHook('afterSanitizeAttributes', hook)
  let html = DOMPurify.sanitize(rawHtml, {
    WHOLE_DOCUMENT: true,
    FORBID_TAGS: ['script', 'noscript', 'iframe', 'object', 'embed', 'form', 'base'],
    FORBID_ATTR: ['ping'],
    ADD_ATTR: ['target'],
  })
  DOMPurify.removeHook('afterSanitizeAttributes')

  // Neutralize remote resources referenced inside <style> blocks.
  if (!allowRemote && /url\(\s*['"]?https?:|@import/i.test(html)) {
    blockedRemote = true
    html = html
      .replace(/url\(\s*['"]?https?:[^)]*\)/gi, 'none')
      .replace(/@import[^;]+;/gi, '')
  }

  return { html, blockedRemote }
}
