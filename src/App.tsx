import { useEffect } from 'react'
import { AppShell } from './components/AppShell'
import { Tooltips } from './components/Tooltips'
import { pst } from './worker/client'
import { useApp } from './store/store'

export default function App() {
  const setWorkerStatus = useApp((s) => s.setWorkerStatus)

  // Dev-only: expose the store + worker so we can drive the app from tests.
  useEffect(() => {
    if (import.meta.env.DEV) {
      const w = window as unknown as Record<string, unknown>
      w.__app = useApp
      w.__pst = pst
    }
  }, [])

  // Prove the parsing worker + Comlink pipeline is alive.
  useEffect(() => {
    let alive = true
    pst
      .ping()
      .then((r) => {
        if (alive) setWorkerStatus(r === 'pong' ? 'ready' : 'error')
      })
      .catch(() => {
        if (alive) setWorkerStatus('error')
      })
    return () => {
      alive = false
    }
  }, [setWorkerStatus])

  return (
    <>
      <AppShell />
      <Tooltips />
    </>
  )
}
