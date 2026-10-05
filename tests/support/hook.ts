import { createElement } from 'react'
import { flushSync } from 'react-dom'
import { createRoot } from 'react-dom/client'

/**
 * The value a hook returns right now, read by rendering a component that
 * calls it once. Enough for hooks that only expose a store; there is no
 * re-rendering here. Needs a DOM (`// @vitest-environment jsdom`).
 */
export function renderHook<T>(hook: () => T): T {
  let value: T | undefined
  let called = false
  const root = createRoot(document.createElement('div'))
  flushSync(() =>
    root.render(
      createElement(() => {
        value = hook()
        called = true
        return null
      }),
    ),
  )
  root.unmount()
  if (!called) throw new Error('the hook was never called')
  return value as T
}
