/**
 * Persistent cache of OCR results, so an image is read only once: re-opening a
 * mailbox (or the same image shared across many emails or mailboxes) reuses the
 * stored text instead of running OCR again.
 *
 * Only the recognized TEXT is stored, keyed by a SHA-256 of the image bytes (a
 * stable, content-addressed key). Images and sharpened canvases are never
 * stored, so the cache stays tiny. Each use renews an entry's life; one left
 * unused for 7 days expires and is dropped on the next open, so it never grows
 * without bound.
 *
 * Lives in IndexedDB on the user's device and is never uploaded. Every operation
 * degrades gracefully to "no cache" (IndexedDB or WebCrypto unavailable,
 * private-mode quota errors, etc.), so OCR still works without it.
 */

const DB_NAME = 'pstv-ocr-cache'
const STORE = 'text'
const DB_VERSION = 1
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000 // keep cached text 7 days after its last use
const DAY_MS = 24 * 60 * 60 * 1000 // only renew an entry's life once a day, to avoid churn

/** Stored value: recognized text plus the time it stops being valid. */
interface Entry {
  text: string
  exp: number
}

let dbPromise: Promise<IDBDatabase | null> | null = null

function openDb(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise
  dbPromise = new Promise((resolve) => {
    try {
      if (typeof indexedDB === 'undefined') return resolve(null)
      const req = indexedDB.open(DB_NAME, DB_VERSION)
      req.onupgradeneeded = () => {
        const db = req.result
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE)
      }
      req.onsuccess = () => {
        purgeExpired(req.result)
        resolve(req.result)
      }
      req.onerror = () => resolve(null)
    } catch {
      resolve(null)
    }
  })
  return dbPromise
}

/** Drop entries past their 7-day expiry (and any in an older format). Best-effort. */
function purgeExpired(db: IDBDatabase): void {
  try {
    const now = Date.now()
    const req = db.transaction(STORE, 'readwrite').objectStore(STORE).openCursor()
    req.onsuccess = () => {
      const cursor = req.result
      if (!cursor) return
      const v = cursor.value as Entry | undefined
      if (!v || typeof v.exp !== 'number' || v.exp < now) cursor.delete()
      cursor.continue()
    }
  } catch {
    /* ignore */
  }
}

/** SHA-256 hex of the image bytes; a stable content key, or null if unavailable. */
export async function hashImageBytes(bytes: ArrayBuffer): Promise<string | null> {
  try {
    if (typeof crypto === 'undefined' || !crypto.subtle) return null
    const digest = await crypto.subtle.digest('SHA-256', bytes)
    const view = new Uint8Array(digest)
    let hex = ''
    for (let i = 0; i < view.length; i++) hex += view[i].toString(16).padStart(2, '0')
    return hex
  } catch {
    return null
  }
}

/**
 * Cached OCR text for a content hash. Returns `undefined` when the image has
 * never been read or its cached text has expired; an empty string means "read,
 * contained no text" (so we do not OCR it again). A valid hit renews the entry's
 * 7-day window, so a mailbox you keep using is never re-read.
 */
export async function getCachedOcr(hash: string): Promise<string | undefined> {
  const db = await openDb()
  if (!db) return undefined
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE, 'readwrite')
      const store = tx.objectStore(STORE)
      const req = store.get(hash)
      req.onsuccess = () => {
        const v = req.result as Entry | undefined
        const now = Date.now()
        if (v && typeof v.text === 'string' && typeof v.exp === 'number' && v.exp >= now) {
          // Sliding expiry: push the 7-day window out from now, but at most once
          // a day so re-opening a mailbox does not rewrite every entry.
          if (now - (v.exp - MAX_AGE_MS) > DAY_MS) {
            try {
              store.put({ text: v.text, exp: now + MAX_AGE_MS }, hash)
            } catch {
              /* ignore */
            }
          }
          resolve(v.text)
        } else {
          resolve(undefined)
        }
      }
      req.onerror = () => resolve(undefined)
    } catch {
      resolve(undefined)
    }
  })
}

/** Store OCR text (possibly empty) for a content hash, valid for 7 days. Best-effort. */
export async function putCachedOcr(hash: string, text: string): Promise<void> {
  const db = await openDb()
  if (!db) return
  return new Promise((resolve) => {
    try {
      const entry: Entry = { text, exp: Date.now() + MAX_AGE_MS }
      const tx = db.transaction(STORE, 'readwrite')
      tx.objectStore(STORE).put(entry, hash)
      tx.oncomplete = () => resolve()
      tx.onerror = () => resolve()
      tx.onabort = () => resolve()
    } catch {
      resolve()
    }
  })
}
