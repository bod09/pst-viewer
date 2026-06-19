import { useEffect, useRef } from 'react'
import { termsRegExp } from '../lib/highlight'

/** Base styles injected into the email document for readability. */
const BASE_CSS = `
*{box-sizing:border-box}
html,body{margin:0;padding:16px;background:#fff;color:#111;
  font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
  font-size:14px;line-height:1.5;word-wrap:break-word;overflow-wrap:anywhere}
img{max-width:100%;height:auto;cursor:zoom-in}
a img{cursor:pointer}
a{color:#0b57d0}
table{max-width:100%}
blockquote{border-left:3px solid #ddd;margin:0 0 0 8px;padding-left:12px;color:#555}
mark.pstv-hit{background:#facc15;color:#111;border-radius:2px}
img.pstv-img-hit{border:3px solid #facc15 !important;border-radius:3px}
html{scrollbar-width:auto;scrollbar-color:#94a3b8 #e2e8f0}
::-webkit-scrollbar{width:14px;height:14px}
::-webkit-scrollbar-track{background:#e2e8f0}
::-webkit-scrollbar-thumb{background:#94a3b8;border-radius:8px;border:3px solid #e2e8f0}
::-webkit-scrollbar-thumb:hover{background:#64748b}
::-webkit-scrollbar-corner{background:#e2e8f0}
`

const MAX_MARKS = 500

/** Remove any highlight wrappers / outlines we previously added. */
function clearHighlights(doc: Document) {
  doc.querySelectorAll('img.pstv-img-hit').forEach((img) => img.classList.remove('pstv-img-hit'))
  const marks = doc.querySelectorAll('mark.pstv-hit')
  if (marks.length) {
    marks.forEach((m) => m.replaceWith(doc.createTextNode(m.textContent ?? '')))
    doc.body?.normalize()
  }
}

/**
 * Outline matched images: cid/blob images by `urls`, and data: body images by
 * their position among data: images (`bodyIndexes`, in document order, which
 * matches how the worker counts them). Returns the count.
 */
function applyImageHighlights(doc: Document, urls: string[], bodyIndexes: number[]): number {
  if (!doc.body || (!urls.length && !bodyIndexes.length)) return 0
  const urlSet = new Set(urls)
  const bodySet = new Set(bodyIndexes)
  let count = 0
  let dataIdx = 0
  for (const img of Array.from(doc.images || [])) {
    const attr = img.getAttribute('src') ?? ''
    let hit = urlSet.has(img.src) || urlSet.has(attr)
    if (/^data:/i.test(attr) || /^data:/i.test(img.src)) {
      if (bodySet.has(dataIdx)) hit = true
      dataIdx++
    }
    if (hit) {
      img.classList.add('pstv-img-hit')
      count++
    }
  }
  return count
}

/** Wrap matches of `terms` in <mark> across text nodes. Returns the match count. */
function applyHighlights(doc: Document, terms: string[]): number {
  const re = termsRegExp(terms)
  if (!re || !doc.body) return 0
  const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const v = node.nodeValue
      if (!v || !v.trim()) return NodeFilter.FILTER_REJECT
      const tag = node.parentElement?.tagName
      if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'MARK' || tag === 'TEXTAREA') {
        return NodeFilter.FILTER_REJECT
      }
      re.lastIndex = 0
      return re.test(v) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT
    },
  })
  const targets: Text[] = []
  let n: Node | null
  while ((n = walker.nextNode())) targets.push(n as Text)

  let count = 0
  for (const textNode of targets) {
    if (count >= MAX_MARKS) break
    const text = textNode.nodeValue ?? ''
    const frag = doc.createDocumentFragment()
    let last = 0
    re.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = re.exec(text))) {
      if (m.index > last) frag.appendChild(doc.createTextNode(text.slice(last, m.index)))
      const mark = doc.createElement('mark')
      mark.className = 'pstv-hit'
      mark.textContent = m[0]
      frag.appendChild(mark)
      count++
      last = m.index + m[0].length
      if (m[0].length === 0) re.lastIndex++ // guard against zero-length matches
      if (count >= MAX_MARKS) break
    }
    if (last < text.length) frag.appendChild(doc.createTextNode(text.slice(last)))
    textNode.parentNode?.replaceChild(frag, textNode)
  }
  return count
}

/**
 * Renders sanitized email HTML inside a sandboxed, same-origin iframe so the
 * email's own CSS displays accurately while scripts cannot run. The iframe
 * auto-sizes to its content (measured on load, on image loads, and on a few
 * timers; deliberately NOT via ResizeObserver, which can feedback-loop when
 * the height we set changes the content layout).
 *
 * When `terms` is non-empty (an active search) the matched words are highlighted
 * and, on first load, the reader scrolls to the first hit.
 */
export function EmailFrame({
  html,
  terms = [],
  highlightImageUrls = [],
  highlightBodyImageIndexes = [],
  onImageClick,
}: {
  html: string
  terms?: string[]
  highlightImageUrls?: string[]
  highlightBodyImageIndexes?: number[]
  onImageClick?: (src: string) => void
}) {
  const ref = useRef<HTMLIFrameElement>(null)
  const termsKey = terms.join('')

  const imgKey = highlightImageUrls.join('') + '|' + highlightBodyImageIndexes.join(',')
  const scrolledForHtmlRef = useRef('')
  const onImageClickRef = useRef(onImageClick)
  onImageClickRef.current = onImageClick

  useEffect(() => {
    const iframe = ref.current
    if (!iframe) return
    const timers: number[] = []

    const onClick = (e: Event) => {
      const target = e.target as HTMLElement | null
      const anchor = target?.closest?.('a') as HTMLAnchorElement | null
      if (anchor?.href) {
        e.preventDefault()
        window.open(anchor.href, '_blank', 'noopener,noreferrer')
        return
      }
      const img = target?.closest?.('img') as HTMLImageElement | null
      if (img) {
        const src = img.currentSrc || img.src
        if (/^(blob:|data:|https?:)/i.test(src)) {
          e.preventDefault()
          onImageClickRef.current?.(src)
        }
      }
    }

    // Scroll the reader pane (the iframe's scrollable ancestor, since the iframe
    // itself is sized to its content) so the first hit is comfortably in view.
    const scrollToFirstHit = () => {
      const doc = iframe.contentDocument
      const target = doc?.querySelector('mark.pstv-hit, img.pstv-img-hit') as HTMLElement | null
      if (!target) return
      let container: HTMLElement | null = iframe.parentElement
      while (container && container !== document.body) {
        const oy = getComputedStyle(container).overflowY
        if ((oy === 'auto' || oy === 'scroll') && container.scrollHeight > container.clientHeight + 4) {
          break
        }
        container = container.parentElement
      }
      const targetTop = target.getBoundingClientRect().top
      if (container && container !== document.body) {
        const top = container.scrollTop + (targetTop - container.getBoundingClientRect().top) - 80
        container.scrollTo({ top: Math.max(0, top), behavior: 'smooth' })
      } else {
        target.scrollIntoView({ block: 'center' })
      }
    }

    const highlight = () => {
      const doc = iframe.contentDocument
      if (!doc || !doc.body) return
      clearHighlights(doc)
      const textCount = terms.length ? applyHighlights(doc, terms) : 0
      const imgCount = applyImageHighlights(doc, highlightImageUrls, highlightBodyImageIndexes)
      // Auto-scroll to the first hit once per opened message (matches can be a
      // text mark or an outlined image, and OCR matches can resolve after load).
      // Not on later term tweaks for the same body, which would yank the scroll.
      if ((textCount > 0 || imgCount > 0) && scrolledForHtmlRef.current !== html) {
        scrolledForHtmlRef.current = html
        timers.push(window.setTimeout(scrollToFirstHit, 400))
      }
    }

    const onLoad = () => {
      const doc = iframe.contentDocument
      if (!doc) return

      const head = doc.head ?? doc.getElementsByTagName('head')[0]
      if (head) {
        const base = doc.createElement('base')
        base.setAttribute('target', '_blank')
        head.insertBefore(base, head.firstChild)
        const style = doc.createElement('style')
        style.textContent = BASE_CSS
        head.appendChild(style)
      }

      doc.addEventListener('click', onClick)

      let last = 0
      const measure = () => {
        const h = Math.max(doc.documentElement?.scrollHeight ?? 0, doc.body?.scrollHeight ?? 0)
        if (h > 0 && Math.abs(h - last) > 2) {
          last = h
          iframe.style.height = `${h}px`
        }
      }
      measure()
      highlight()
      // Re-measure after late layout (fonts / inline images / reflow).
      for (const t of [50, 200, 500, 1200]) timers.push(window.setTimeout(measure, t))
      // Re-measure as each image finishes loading.
      for (const img of Array.from(doc.images || [])) {
        if (!img.complete) img.addEventListener('load', measure, { once: true })
      }
    }

    iframe.addEventListener('load', onLoad)
    // Terms changed without an HTML change (the iframe is already loaded): just
    // re-highlight in place, without yanking the user's scroll position.
    const doc = iframe.contentDocument
    if (doc?.body && doc.readyState === 'complete') highlight()

    return () => {
      iframe.removeEventListener('load', onLoad)
      for (const t of timers) clearTimeout(t)
    }
    // `terms` is captured via the stable `termsKey`; depending on the array
    // itself would re-run this effect on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [html, termsKey, imgKey])

  return (
    <iframe
      ref={ref}
      srcDoc={html}
      sandbox="allow-same-origin"
      title="Email content"
      className="w-full border-0 bg-white"
      style={{ height: 0 }}
    />
  )
}
