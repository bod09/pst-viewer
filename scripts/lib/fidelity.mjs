// @ts-check
/**
 * The working parts of the fidelity check: record what the worker reads from a
 * mailbox, and compare two such records.
 *
 * Used by scripts/fidelity.mjs (one mailbox, from the command line) and by
 * tests/worker/fidelity.test.ts (the baselines kept in the repository). It is
 * plain JavaScript so the script needs no build step; the types are in the
 * JSDoc comments.
 */
import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

/**
 * @typedef {import('../../src/worker/pst.worker').PstWorkerApi} Api
 * @typedef {import('../../src/types').FolderNode} FolderNode
 * @typedef {import('../../src/types').SourceIndex} SourceIndex
 * @typedef {import('../../src/lib/zip').ZipScanResult} ZipScanResult
 *
 * @typedef {object} Row One message: what the list shows, and (for the
 *   messages that are opened, see `full`) what the reader shows.
 * @property {string} id
 * @property {string} subject
 * @property {string} from
 * @property {string} to
 * @property {number | null} date
 * @property {boolean} att
 * @property {string} cls
 * @property {boolean} [opened] False when the message is listed but cannot be opened.
 * @property {string} [kind] email, contact, appointment and so on.
 * @property {string | null} [html] Hash of the HTML body, or null if there is none.
 * @property {string | null} [text] Hash of the plain text body, or null.
 * @property {string} [people] Hash of the sender and every recipient, To, Cc and Bcc.
 * @property {string} [headers] Hash of the transport headers.
 * @property {string} [marks] Hash of categories, importance, sensitivity and follow-up.
 * @property {string | null} [card] Hash of the contact, appointment, task, journal or
 *   list card, or null for an ordinary email.
 * @property {string} [atts] Attachment names, as a JSON list.
 * @property {number[][]} [files] Per attachment: size, 1 if inline, 1 if a message.
 * @property {string} [types] Hash of each attachment's type and content id, and of
 *   the inline pictures.
 * @property {string} [bytes] Hash of every attachment's bytes, and of what each
 *   attached message says (only when `full`).
 *
 * @typedef {object} FolderRecord
 * @property {string[]} path Folder names from the top of the tree down.
 * @property {number} nth 0, or more when an earlier folder has the same path.
 * @property {number} unreadable
 * @property {Row[]} rows
 *
 * @typedef {object} Snapshot
 * @property {number} format
 * @property {string} file
 * @property {boolean} full Whether every message was opened, or one in ten.
 * @property {boolean} redacted Whether text was replaced by hashes of itself.
 * @property {number} messages
 * @property {number} bodies
 * @property {FolderRecord[]} folders
 */

/** Bumped when a snapshot's shape changes, so an old baseline is refused, not misread. */
export const FORMAT = 3

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)))

/** @param {string | Uint8Array | null | undefined} s */
export const sha = (s) =>
  createHash('sha256')
    .update(s ?? '')
    .digest('hex')
    .slice(0, 16)

/**
 * JSON with the keys of every object in a fixed order, so the same value
 * always gives the same text whatever order its fields were set in.
 *
 * @param {unknown} value
 * @returns {string}
 */
function stable(value) {
  return JSON.stringify(value, (_key, v) =>
    v && typeof v === 'object' && !Array.isArray(v) && !(v instanceof ArrayBuffer)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : v,
  )
}

/**
 * What the reader shows for one opened message, as values that can be
 * compared: every body, person, header, mark, card and attachment.
 *
 * Each part is hashed on its own, so a difference names the part that
 * changed. Attachment bytes are read only when `full`, since on a large
 * mailbox that is most of the file.
 *
 * @param {Api} api
 * @param {string} sourceId
 * @param {string} messageId
 * @param {import('../../src/types').MessageContent | null} content
 * @param {boolean} full
 * @returns {Promise<Partial<Row>>}
 */
async function contentRecord(api, sourceId, messageId, content, full) {
  // Listed but not openable is a state of its own, not an empty message.
  if (!content) return { opened: false }
  const card = content.contact ?? content.appointment ?? content.distlist ?? content.task ?? content.journal ?? null
  /** @type {Partial<Row>} */
  const record = {
    opened: true,
    kind: content.itemKind,
    html: content.html === null ? null : sha(content.html),
    text: content.text === null ? null : sha(content.text),
    people: sha(stable({ from: [content.fromName, content.fromEmail], to: content.to, cc: content.cc, bcc: content.bcc })),
    headers: sha(content.headers),
    marks: sha(
      stable({
        categories: content.categories,
        importance: content.importance,
        sensitivity: content.sensitivity,
        followUp: content.followUp,
      }),
    ),
    card: card ? sha(stable(card)) : null,
    atts: JSON.stringify(content.attachments.map((a) => a.name)),
    files: content.attachments.map((a) => [a.size, a.isInline ? 1 : 0, a.isEmbeddedMessage ? 1 : 0]),
    types: sha(
      stable({
        attachments: content.attachments.map((a) => [a.mime, a.cid ?? null]),
        inline: content.inlineImages.map((i) => [i.cid, i.mime, i.data.byteLength, sha(new Uint8Array(i.data))]),
      }),
    ),
  }
  if (full) {
    /** @type {(string | null)[]} */
    const parts = []
    for (const a of content.attachments) {
      if (a.isEmbeddedMessage) {
        const inner = (await api.getEmbeddedMessageContent(sourceId, messageId, a.index))?.content
        parts.push(inner ? sha(stable([inner.subject, inner.html, inner.text, inner.attachments.map((x) => x.name)])) : null)
      } else {
        const data = await api.getAttachmentData(sourceId, messageId, a.index)
        parts.push(data ? sha(new Uint8Array(data.data)) : null)
      }
    }
    record.bytes = sha(stable(parts))
  }
  return record
}

/**
 * Bundle the worker (and the zip scanner the page uses) for Node.
 *
 * The worker is browser code, but nothing it does while reading a mailbox
 * needs a browser: Comlink is replaced with a stub that hands us the API
 * object it would have exposed, and the index cache disables itself when
 * IndexedDB is absent, so every run is a fresh read.
 *
 * @returns {Promise<{ api: Api, scanZip: (file: File) => Promise<ZipScanResult> }>}
 */
export async function loadWorker() {
  const { build } = await import('vite')
  const outDir = join(ROOT, 'node_modules/.fidelity-build')
  const stub = join(outDir, 'comlink-stub.mjs')
  await mkdir(outDir, { recursive: true })
  await writeFile(
    stub,
    'export function expose(api) { globalThis.__pstWorkerApi = api }\n' +
      'export function proxy(v) { return v }\n' +
      'export function transfer(v) { return v }\n' +
      'export function wrap(v) { return v }\n',
  )

  await build({
    root: ROOT,
    logLevel: 'error',
    configFile: false,
    publicDir: false,
    resolve: { alias: { comlink: stub } },
    build: {
      outDir,
      emptyOutDir: false,
      minify: false,
      target: 'node20',
      // An SSR build resolves for Node and leaves dependencies to be imported
      // natively, instead of swapping in the browser shims a normal build uses
      // (node-forge's buffer shim in particular does not survive that).
      ssr: true,
      rollupOptions: {
        input: {
          worker: join(ROOT, 'src/worker/pst.worker.ts'),
          zip: join(ROOT, 'src/lib/zip.ts'),
        },
        output: { entryFileNames: '[name].js' },
      },
    },
  })
  // The build may split into several .js chunks; this marks them all as ESM
  // so Node imports them the way the bundler wrote them.
  await writeFile(join(outDir, 'package.json'), '{ "type": "module" }\n')

  await import(pathToFileURL(join(outDir, 'worker.js')).href)
  const api = /** @type {{ __pstWorkerApi?: Api }} */ (globalThis).__pstWorkerApi
  if (!api) throw new Error('worker did not expose its API')
  const { scanZipForPsts } = await import(pathToFileURL(join(outDir, 'zip.js')).href)
  return { api, scanZip: scanZipForPsts }
}

/**
 * Every folder in the tree with the path of names leading to it, the root
 * first (as the empty path), then in the order the sidebar shows them.
 *
 * A folder is known by its path, not its position, so a folder that appears
 * or disappears is reported as that folder rather than shifting every folder
 * after it. Two folders with the same path are told apart by `nth`.
 *
 * @param {FolderNode} root
 * @param {string[]} [prefix]
 * @returns {{ id: string, path: string[], nth: number }[]}
 */
export function folderPaths(root, prefix = []) {
  /** @type {{ id: string, path: string[], nth: number }[]} */
  const out = []
  /** @type {Map<string, number>} */
  const seen = new Map()
  /** @param {FolderNode} node @param {string[]} path */
  const walk = (node, path) => {
    const key = JSON.stringify(path)
    const nth = seen.get(key) ?? 0
    seen.set(key, nth + 1)
    out.push({ id: node.id, path, nth })
    for (const child of node.children ?? []) walk(child, [...path, child.name])
  }
  walk(root, prefix)
  return out
}

/**
 * Record what the worker reads from one open mailbox.
 *
 * @param {Api} api
 * @param {string} sourceId
 * @param {SourceIndex} index
 * @param {{ full: boolean, prefix?: string[] }} options
 * @returns {Promise<Pick<Snapshot, 'messages' | 'bodies' | 'folders'>>}
 */
export async function snapshotSource(api, sourceId, index, { full, prefix = [] }) {
  /** @type {FolderRecord[]} */
  const folders = []
  let messages = 0
  let bodies = 0

  for (const folder of folderPaths(index.rootFolder, prefix)) {
    const { messages: metas, unreadable } = await api.getFolderMessages(sourceId, folder.id)
    /** @type {Row[]} */
    const rows = []
    for (const [i, m] of metas.entries()) {
      // Identity and the fields the list shows. Recorded in folder order,
      // because a change that reorders or duplicates messages is exactly the
      // kind this check exists to catch.
      /** @type {Row} */
      const row = {
        id: m.id,
        subject: m.subject,
        from: `${m.fromName} <${m.fromEmail}>`,
        to: m.to,
        date: m.date,
        att: m.hasAttachments,
        cls: m.messageClass,
      }
      // Opening a message is the expensive part, so sample unless `full`. A
      // wrong-message bug shows up in the list fields too, but what the
      // reader shows is what proves the content belongs to this message.
      if (full || i % 10 === 0) {
        const content = await api.getMessageContent(sourceId, m.id)
        Object.assign(row, await contentRecord(api, sourceId, m.id, content, full))
        bodies++
      }
      rows.push(row)
      messages++
    }
    folders.push({ path: folder.path, nth: folder.nth, unreadable, rows })
  }
  return { messages, bodies, folders }
}

/**
 * Open a file the way dropping it on the app would, and record what is read.
 *
 * A mailbox opens as itself. A message opens as a one-message mailbox. A zip
 * is searched as the page searches it: every mailbox inside is read, each
 * under its own name, and the loose messages together as one more.
 *
 * @param {Api} api
 * @param {File} file
 * @param {{ full: boolean, scanZip: (file: File) => Promise<ZipScanResult> }} options
 * @returns {Promise<Snapshot>}
 */
export async function snapshotFile(api, file, { full, scanZip }) {
  /** @type {Snapshot} */
  const snapshot = {
    format: FORMAT,
    file: file.name,
    full,
    redacted: false,
    messages: 0,
    bodies: 0,
    folders: [],
  }
  let n = 0
  /** @param {(id: string) => Promise<SourceIndex>} open @param {string[]} prefix */
  const read = async (open, prefix) => {
    const sourceId = `fidelity-${n++}`
    const index = await open(sourceId)
    try {
      await api.indexSource(sourceId)
      const part = await snapshotSource(api, sourceId, index, { full, prefix })
      snapshot.messages += part.messages
      snapshot.bodies += part.bodies
      snapshot.folders.push(...part.folders)
    } finally {
      await api.closeSource(sourceId)
    }
  }

  if (/\.zip$/i.test(file.name)) {
    const { psts, msgs } = await scanZip(file)
    if (psts.length === 0 && msgs.length === 0) throw new Error('no mailbox or message files in this zip')
    for (const entry of psts) await read((id) => api.openSource(id, entry.file), [entry.path])
    if (msgs.length) {
      const files = msgs.map((m) => m.file)
      await read((id) => api.openMsgSource(id, files), ['(loose messages)'])
    }
  } else if (/\.(msg|eml)$/i.test(file.name)) {
    await read((id) => api.openMsgSource(id, [file]), [])
  } else {
    await read((id) => api.openSource(id, file), [])
  }
  // Number folders that share a path across the whole file, not just within
  // one mailbox of a zip, so no two records can ever be taken for each other.
  /** @type {Map<string, number>} */
  const seen = new Map()
  for (const folder of snapshot.folders) {
    const key = JSON.stringify(folder.path)
    folder.nth = seen.get(key) ?? 0
    seen.set(key, folder.nth + 1)
  }
  return snapshot
}

/**
 * The same snapshot with every piece of text from the mailbox (folder names,
 * subjects, people, attachment names) replaced by a hash of itself.
 *
 * A redacted snapshot holds none of the mail's words and still fails when
 * any of it is read differently, which is how the baselines of the public
 * test mailboxes can be kept in the repository. It is not a way to publish
 * private mail: the hash of a short or guessable text ("Inbox", a common
 * subject) can be found by guessing.
 *
 * @param {Snapshot} snapshot
 * @returns {Snapshot}
 */
export function redact(snapshot) {
  if (snapshot.redacted) return snapshot
  return {
    ...snapshot,
    redacted: true,
    folders: snapshot.folders.map((f) => ({
      ...f,
      path: f.path.map(sha),
      rows: f.rows.map((r) => ({
        ...r,
        subject: sha(r.subject),
        from: sha(r.from),
        to: sha(r.to),
        // Everything else recorded for a message is already a hash, a number
        // or one of a fixed set of words (see the Row type).
        ...(r.atts === undefined ? {} : { atts: sha(r.atts) }),
      })),
    })),
  }
}

/** @param {FolderRecord} f */
const folderKey = (f) => JSON.stringify([f.path, f.nth])

/**
 * A value as it is shown in a difference. Unlike plain JSON it tells apart
 * the values JSON would merge: a missing field, null, and a number that is
 * not a number.
 *
 * @param {unknown} v
 */
const show = (v) =>
  v === undefined ? 'undefined' : JSON.stringify(v, (_k, x) => (typeof x === 'number' && !Number.isFinite(x) ? String(x) : x))

/**
 * What differs between a baseline and what is read now, in words that point
 * at the cause. Empty when they match.
 *
 * `plain` is the current snapshot before redaction, when the two being
 * compared are redacted: it lets a difference be shown as the folder and text
 * it is about, read from the mailbox in front of you, instead of as a hash.
 * Leave it out to keep that text out of the output (a public test log, say):
 * folders are then named by their position.
 *
 * @param {Snapshot} baseline
 * @param {Snapshot} current
 * @param {Snapshot} [plain]
 * @param {number} [limit]
 * @returns {string[]}
 */
export function diff(baseline, current, plain = current, limit = 30) {
  /** @type {string[]} */
  const problems = []
  const redacted = current.redacted
  const reveal = !plain.redacted
  /** @param {FolderRecord} f @param {number} position */
  const nameOf = (f, position) =>
    reveal
      ? (f.path.length ? f.path.join(' > ') : '(top of the mailbox)') + (f.nth ? ` #${f.nth + 1}` : '')
      : `folder ${position + 1}`

  if (baseline.messages !== current.messages) {
    problems.push(`message count: baseline ${baseline.messages}, now ${current.messages}`)
  } else if (baseline.bodies !== current.bodies) {
    problems.push(`messages opened: baseline ${baseline.bodies}, now ${current.bodies}`)
  }

  /** @type {Map<string, { folder: FolderRecord, plain: FolderRecord, position: number }>} */
  const now = new Map()
  for (const [position, folder] of current.folders.entries()) {
    const key = folderKey(folder)
    // Cannot happen for a snapshot made by snapshotFile, which numbers folders
    // that share a path. Checked because a silent overwrite here would hide one.
    if (now.has(key)) problems.push(`two folders are recorded under the same name: ${nameOf(plain.folders[position], position)}`)
    now.set(key, { folder, plain: plain.folders[position], position })
  }
  const before = new Set(baseline.folders.map(folderKey))
  if (before.size !== baseline.folders.length) problems.push('the baseline records two folders under the same name')

  for (const { folder, plain: plainFolder, position } of now.values()) {
    if (before.has(folderKey(folder))) continue
    // An empty folder appearing is still a change in what the sidebar shows.
    problems.push(`new folder: ${nameOf(plainFolder, position)} (${folder.rows.length} messages)`)
  }

  for (const old of baseline.folders) {
    if (problems.length > limit) break
    const match = now.get(folderKey(old))
    if (!match) {
      const name =
        redacted || !reveal
          ? `a folder that held ${old.rows.length} messages (its name is hashed in the baseline)`
          : nameOf(old, 0)
      problems.push(`folder gone: ${name}`)
      continue
    }
    const { folder, plain: plainFolder, position } = match
    const name = nameOf(plainFolder, position)
    if (old.unreadable !== folder.unreadable) {
      problems.push(`${name}: ${old.unreadable} unreadable in baseline, ${folder.unreadable} now`)
    }
    if (old.rows.length !== folder.rows.length) {
      problems.push(`${name}: ${old.rows.length} messages in baseline, ${folder.rows.length} now`)
    }
    const n = Math.min(old.rows.length, folder.rows.length)
    for (let i = 0; i < n && problems.length <= limit; i++) {
      const a = /** @type {Record<string, unknown>} */ (/** @type {unknown} */ (old.rows[i]))
      const b = /** @type {Record<string, unknown>} */ (/** @type {unknown} */ (folder.rows[i]))
      const p = /** @type {Record<string, unknown>} */ (/** @type {unknown} */ (plainFolder.rows[i]))
      for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
        if (show(a[key]) === show(b[key])) continue
        // Hashes on both sides say nothing a person can use; the text as it
        // is read now does.
        const hashed = redacted && show(b[key]) !== show(p[key])
        problems.push(
          hashed
            ? `${name}[${i}] ${key}: differs from the baseline, now ${show(p[key])}`
            : `${name}[${i}] ${key}: ${show(a[key])} -> ${show(b[key])}`,
        )
        break
      }
    }
  }

  // The order of folders is what the sidebar shows, so it is part of what is
  // read. Only worth saying when nothing else explains it.
  if (problems.length === 0) {
    const kept = (/** @type {FolderRecord[]} */ folders, /** @type {Set<string> | Map<string, unknown>} */ other) =>
      folders.map(folderKey).filter((k) => other.has(k))
    if (kept(baseline.folders, now).join('\n') !== kept(current.folders, before).join('\n')) {
      problems.push('the folders are the same, but listed in a different order')
    }
  }
  return problems.slice(0, limit)
}

/**
 * Why a stored baseline cannot be compared against, or null if it can.
 *
 * @param {unknown} baseline
 * @returns {string | null}
 */
export function unusable(baseline) {
  const b = /** @type {Partial<Snapshot> | null} */ (baseline)
  if (!b || typeof b !== 'object') return 'it is not a baseline'
  if (b.format !== FORMAT) return 'it was written by an older version of this check'
  const whole =
    typeof b.full === 'boolean' &&
    typeof b.redacted === 'boolean' &&
    typeof b.messages === 'number' &&
    typeof b.bodies === 'number' &&
    Array.isArray(b.folders) &&
    b.folders.every((f) => f && Array.isArray(f.path) && typeof f.nth === 'number' && Array.isArray(f.rows))
  return whole ? null : 'it is incomplete'
}

/**
 * Check a file against a baseline, sampling and redacting exactly as the
 * baseline was recorded, so the two can differ only if the mail is read
 * differently.
 *
 * With `reveal` (the default) a difference in a redacted baseline is shown
 * with the text as it reads now. Turn it off where the output is public.
 *
 * @param {Api} api
 * @param {File} file
 * @param {Snapshot} baseline
 * @param {(file: File) => Promise<ZipScanResult>} scanZip
 * @param {{ reveal?: boolean }} [options]
 * @returns {Promise<{ problems: string[], current: Snapshot }>}
 */
export async function check(api, file, baseline, scanZip, { reveal = true } = {}) {
  const plain = await snapshotFile(api, file, { full: baseline.full, scanZip })
  const current = baseline.redacted ? redact(plain) : plain
  return { problems: diff(baseline, current, reveal ? plain : current), current: plain }
}
