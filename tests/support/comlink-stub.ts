/**
 * Stand-in for Comlink in tests (aliased in vitest.config.ts).
 *
 * The worker ends with `Comlink.expose(api)`, which needs a real worker to
 * talk through. Here it just hands the API object over, so a test can call the
 * worker's functions directly. scripts/lib/worker-api.mjs does the same for
 * the fidelity check.
 */
export function expose(api: unknown): void {
  ;(globalThis as { __pstWorkerApi?: unknown }).__pstWorkerApi = api
}
export const proxy = <T>(value: T): T => value
export const transfer = <T>(value: T): T => value
export const wrap = <T>(value: T): T => value
