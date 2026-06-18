import { useEffect, useRef } from 'react'

/** Base styles injected into the email document for readability. */
const BASE_CSS = `
*{box-sizing:border-box}
html,body{margin:0;padding:16px;background:#fff;color:#111;
  font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
  font-size:14px;line-height:1.5;word-wrap:break-word;overflow-wrap:anywhere}
img{max-width:100%;height:auto}
a{color:#0b57d0}
table{max-width:100%}
blockquote{border-left:3px solid #ddd;margin:0 0 0 8px;padding-left:12px;color:#555}
html{scrollbar-width:auto;scrollbar-color:#94a3b8 #e2e8f0}
::-webkit-scrollbar{width:14px;height:14px}
::-webkit-scrollbar-track{background:#e2e8f0}
::-webkit-scrollbar-thumb{background:#94a3b8;border-radius:8px;border:3px solid #e2e8f0}
::-webkit-scrollbar-thumb:hover{background:#64748b}
::-webkit-scrollbar-corner{background:#e2e8f0}
`

/**
 * Renders sanitized email HTML inside a sandboxed, same-origin iframe so the
 * email's own CSS displays accurately while scripts cannot run. The iframe
 * auto-sizes to its content (measured on load, on image loads, and on a few
 * timers — deliberately NOT via ResizeObserver, which can feedback-loop when
 * the height we set changes the content layout).
 */
export function EmailFrame({ html }: { html: string }) {
  const ref = useRef<HTMLIFrameElement>(null)

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
        const h = Math.max(
          doc.documentElement?.scrollHeight ?? 0,
          doc.body?.scrollHeight ?? 0,
        )
        if (h > 0 && Math.abs(h - last) > 2) {
          last = h
          iframe.style.height = `${h}px`
        }
      }
      measure()
      // Re-measure after late layout (fonts / inline images / reflow).
      for (const t of [50, 200, 500, 1200]) timers.push(window.setTimeout(measure, t))
      // Re-measure as each image finishes loading.
      for (const img of Array.from(doc.images || [])) {
        if (!img.complete) img.addEventListener('load', measure, { once: true })
      }
    }

    iframe.addEventListener('load', onLoad)
    return () => {
      iframe.removeEventListener('load', onLoad)
      for (const t of timers) clearTimeout(t)
    }
  }, [html])

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
