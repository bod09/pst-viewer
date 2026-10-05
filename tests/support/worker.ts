import type { PstWorkerApi } from '../../src/worker/pst.worker'

/**
 * The worker's API, loaded into this process (see comlink-stub.ts).
 *
 * The worker keeps its state (open mailboxes, the search index) in module
 * variables. Vitest gives every test file its own copy of each module, so one
 * file's mailboxes never show up in another's searches; within a file, close
 * what you open or use distinct source ids.
 */
export async function loadWorker(): Promise<PstWorkerApi> {
  await import('../../src/worker/pst.worker')
  const api = (globalThis as { __pstWorkerApi?: PstWorkerApi }).__pstWorkerApi
  if (!api) throw new Error('the worker did not expose its API')
  return api
}
