import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'

interface Tip {
  text: string
  x: number
  y: number
  below: boolean
}

/**
 * One global, theme-styled tooltip. Any element with a `data-tip` attribute
 * gets a custom tooltip on hover — no native browser tooltips.
 */
export function Tooltips() {
  const [tip, setTip] = useState<Tip | null>(null)

  useEffect(() => {
    let timer = 0
    let current: HTMLElement | null = null

    const hide = () => {
      window.clearTimeout(timer)
      current = null
      setTip(null)
    }
    const onOver = (e: MouseEvent) => {
      const el = (e.target as HTMLElement | null)?.closest?.('[data-tip]') as HTMLElement | null
      if (!el) return
      const text = el.getAttribute('data-tip')
      if (!text) return
      current = el
      window.clearTimeout(timer)
      timer = window.setTimeout(() => {
        if (current !== el || !el.isConnected) return
        const r = el.getBoundingClientRect()
        const below = r.top < 96
        setTip({ text, x: r.left + r.width / 2, y: below ? r.bottom + 8 : r.top - 8, below })
      }, 350)
    }
    const onOut = (e: MouseEvent) => {
      if ((e.target as HTMLElement | null)?.closest?.('[data-tip]')) hide()
    }

    document.addEventListener('mouseover', onOver)
    document.addEventListener('mouseout', onOut)
    document.addEventListener('mousedown', hide)
    window.addEventListener('scroll', hide, true)
    return () => {
      window.clearTimeout(timer)
      document.removeEventListener('mouseover', onOver)
      document.removeEventListener('mouseout', onOut)
      document.removeEventListener('mousedown', hide)
      window.removeEventListener('scroll', hide, true)
    }
  }, [])

  if (!tip) return null
  return createPortal(
    <div
      style={{
        position: 'fixed',
        left: tip.x,
        top: tip.y,
        transform: tip.below ? 'translate(-50%, 0)' : 'translate(-50%, -100%)',
        zIndex: 10000,
        pointerEvents: 'none',
      }}
      className="max-w-xs whitespace-pre-line break-words rounded-md bg-slate-800 px-2.5 py-1.5 text-center text-xs text-slate-100 shadow-xl ring-1 ring-slate-700"
    >
      {tip.text}
    </div>,
    document.body,
  )
}
