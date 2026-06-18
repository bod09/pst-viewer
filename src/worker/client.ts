import * as Comlink from 'comlink'
import type { PstWorkerApi } from './pst.worker.ts'

// Vite bundles this worker (ES module format set in vite.config.ts).
const worker = new Worker(new URL('./pst.worker.ts', import.meta.url), {
  type: 'module',
  name: 'pst-parser',
})

/** Typed proxy to the parsing worker. Every call returns a Promise. */
export const pst = Comlink.wrap<PstWorkerApi>(worker)
