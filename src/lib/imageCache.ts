/**
 * The store of remote images already fetched while reading mail.
 *
 * Fetching each one only once is the reason a sender is not pinged again on
 * every re-read, but it also leaves a durable record on the device of which
 * remote content the mail referenced. Someone reviewing a mailbox may not
 * want to keep that, so it can be emptied, and it is emptied automatically
 * when remote images are switched off.
 *
 * The name matches the runtime caching rule in vite.config.ts.
 */
const CACHE_NAME = 'remote-email-images'

/** How many remote images are currently held, or 0 if none/unsupported. */
export async function cachedImageCount(): Promise<number> {
  try {
    if (typeof caches === 'undefined') return 0
    if (!(await caches.has(CACHE_NAME))) return 0
    const cache = await caches.open(CACHE_NAME)
    return (await cache.keys()).length
  } catch {
    return 0
  }
}

/** Empty the store. Safe to call when it does not exist. */
export async function clearCachedImages(): Promise<void> {
  try {
    if (typeof caches === 'undefined') return
    await caches.delete(CACHE_NAME)
  } catch {
    /* nothing kept is better than an error here */
  }
}
