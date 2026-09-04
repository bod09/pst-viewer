/**
 * On-device cache of a mailbox's finished search documents, keyed by a file
 * fingerprint (name, size, last-modified). A re-opened mailbox becomes
 * searchable immediately instead of re-reading every message; the cached
 * documents already include any OCR text merged during the original pass.
 *
 * Same policy as the OCR cache: IndexedDB, sliding 7-day expiry from last
 * use, best-effort everywhere (a cache failure only means a fresh scan).
 */

const DB_NAME = 'pstv-index-cache'
const STORE = 'docs'
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000
const DAY_MS = 24 * 60 * 60 * 1000

export interface CachedSearchDoc {
  id: string
  sourceId: string
  messageId: string
  folderId: string
  subject: string
  from: string
  to: string
  body: string
  attachments: string
  ocr: string
  date: number | null
  hasAttachments: boolean
  importance: 'high' | 'low' | null
  flagged: boolean
  unread: boolean
}

/** Bump when the entry shape changes; older entries are treated as misses.
 *  4: versions up to 3 could store an indexing pass that had silently lost
 *  folders, which then hid that mail from search on every later open. */
const ENTRY_VERSION = 4

interface Entry {
  docs: CachedSearchDoc[]
  /** People seen in the mailbox: [display label, message count]. */
  people?: [string, number][]
  exp: number
  v?: number
}

export interface CachedIndex {
  docs: CachedSearchDoc[]
  people: [string, number][]
}

export function fingerprintOf(file: File): string {
  return `${file.name}|${file.size}|${file.lastModified}`
}

let dbPromise: Promise<IDBDatabase | null> | null = null

function openDb(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise
  dbPromise = new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB_NAME, 1)
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE)
      }
      req.onsuccess = () => {
        const db = req.result
        // Sweep expired entries once per session.
        try {
          const now = Date.now()
          const tx = db.transaction(STORE, 'readwrite')
          const cursorReq = tx.objectStore(STORE).openCursor()
          cursorReq.onsuccess = () => {
            const cursor = cursorReq.result
            if (!cursor) return
            const v = cursor.value as Entry | undefined
            if (!v || typeof v.exp !== 'number' || v.exp < now) cursor.delete()
            cursor.continue()
          }
        } catch {
          /* ignore */
        }
        resolve(db)
      }
      req.onerror = () => resolve(null)
    } catch {
      resolve(null)
    }
  })
  return dbPromise
}

/** Cached index for a file fingerprint, or undefined. Slides the expiry. */
export async function getCachedIndex(fp: string): Promise<CachedIndex | undefined> {
  const db = await openDb()
  if (!db) return undefined
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE, 'readwrite')
      const store = tx.objectStore(STORE)
      const req = store.get(fp)
      req.onsuccess = () => {
        const v = req.result as Entry | undefined
        const now = Date.now()
        if (v && v.v === ENTRY_VERSION && Array.isArray(v.docs) && typeof v.exp === 'number' && v.exp >= now) {
          if (now - (v.exp - MAX_AGE_MS) > DAY_MS) {
            try {
              store.put({ ...v, exp: now + MAX_AGE_MS }, fp)
            } catch {
              /* ignore */
            }
          }
          resolve({ docs: v.docs, people: v.people ?? [] })
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

/** Store the finished search docs and people list for a file fingerprint. */
/**
 * Store the finished documents. Reports whether they were actually written:
 * the caller keeps its own copies when they were not, because the text in
 * them is what exact-phrase search checks against. Storage can refuse a write
 * for ordinary reasons - a large mailbox exceeding the quota, or private
 * browsing - and search must not quietly stop matching because of it.
 */
export async function putCachedIndex(
  fp: string,
  docs: CachedSearchDoc[],
  people: [string, number][],
): Promise<boolean> {
  const db = await openDb()
  if (!db) return false
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE, 'readwrite')
      tx.objectStore(STORE).put(
        { docs, people, exp: Date.now() + MAX_AGE_MS, v: ENTRY_VERSION } satisfies Entry,
        fp,
      )
      tx.oncomplete = () => resolve(true)
      tx.onerror = () => resolve(false)
      tx.onabort = () => resolve(false)
    } catch {
      resolve(false)
    }
  })
}
