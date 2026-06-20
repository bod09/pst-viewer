import { useEffect } from 'react'
import { AppShell } from './components/AppShell'
import { Tooltips } from './components/Tooltips'
import { pst } from './worker/client'
import { useApp } from './store/store'

export default function App() {
  // Dev-only: expose the store + worker so we can drive the app from tests.
  useEffect(() => {
    if (import.meta.env.DEV) {
      const w = window as unknown as Record<string, unknown>
      w.__app = useApp
      w.__pst = pst
    }
  }, [])

  // Warm up the parsing worker + Comlink pipeline early so the first file opens fast.
  useEffect(() => {
    void pst.ping()
  }, [])

  return (
    <>
      <AppShell />
      <Tooltips />
    </>
  )
}
