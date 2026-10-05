import { fixtureFiles } from './fixtures.mjs'

/** Bytes as a File, the way a dropped file reaches the worker. */
export function fileOf(name: string, bytes: Uint8Array | string, lastModified = 1_700_000_000_000): File {
  const data = typeof bytes === 'string' ? new TextEncoder().encode(bytes) : (bytes as Uint8Array<ArrayBuffer>)
  return new File([data], name, { lastModified })
}

/** One of the files `npm run fixtures` writes, as a File. */
export function fixture(name: string): File {
  const bytes = fixtureFiles()[name]
  if (!bytes) throw new Error(`no fixture called ${name}`)
  return fileOf(name, bytes)
}
