/**
 * Fidelity check: does the worker still read a mailbox the same way?
 *
 * Indexing is the part of this app where a change can look completely fine —
 * the right number of messages, sensible timings, search returning hits — while
 * quietly attaching the wrong content to the wrong message. Counts and totals
 * do not catch that. This does: it drives the real worker over a real mailbox,
 * records what every message actually says, and compares that against a stored
 * baseline, in order, message by message.
 *
 * Usage:
 *   node scripts/fidelity.mjs <mailbox> --update   # record a baseline
 *   node scripts/fidelity.mjs <mailbox>            # check against it
 *   node scripts/fidelity.mjs <mailbox> --update --full   # hash every body, not 1 in 10
 *
 * A check always samples bodies the way its baseline did, so --full only
 * means anything while recording one.
 *
 * Mailboxes and baselines stay on your machine: baselines hold real subjects
 * and sender names, so they are git-ignored along with the files they describe.
 */
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { openAsBlob } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const BASELINE_DIR = join(ROOT, '.fidelity')

const args = process.argv.slice(2)
const mailboxPath = args.find((a) => !a.startsWith('--'))
const update = args.includes('--update')
const full = args.includes('--full')

if (!mailboxPath) {
  console.error('usage: node scripts/fidelity.mjs <mailbox.pst|.ost|.msg|.eml> [--update] [--full]')
  process.exit(2)
}

/**
 * Bundle the worker for Node.
 *
 * The worker is browser code, but nothing it does while reading a mailbox
 * needs a browser: Comlink is replaced with a stub that hands us the API
 * object it would have exposed, and the index cache disables itself when
 * IndexedDB is absent, so every run is a fresh read.
 */
async function loadWorkerApi() {
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
      ssr: join(ROOT, 'src/worker/pst.worker.ts'),
      rollupOptions: { output: { entryFileNames: 'worker.js' } },
    },
  })
  // The build may split into several .js chunks; this marks them all as ESM
  // so Node imports them the way the bundler wrote them.
  await writeFile(join(outDir, 'package.json'), '{ "type": "module" }\n')

  await import(join(outDir, 'worker.js'))
  const api = globalThis.__pstWorkerApi
  if (!api) throw new Error('worker did not expose its API')
  return api
}

/** Every folder id in the tree, in the order the sidebar shows them. */
function folderIds(node, out = []) {
  out.push({ id: node.id, name: node.name })
  for (const child of node.children ?? []) folderIds(child, out)
  return out
}

const sha = (s) => createHash('sha256').update(s ?? '').digest('hex').slice(0, 16)

async function snapshot(api, sourceId, index, hashEveryBody) {
  const folders = []
  let messages = 0
  let bodies = 0

  for (const folder of folderIds(index.rootFolder)) {
    const { messages: metas, unreadable } = await api.getFolderMessages(sourceId, folder.id)
    const rows = []
    for (const [i, m] of metas.entries()) {
      // Identity and the fields the list shows. Recorded in folder order,
      // because a change that reorders or duplicates messages is exactly the
      // kind this check exists to catch.
      const row = {
        id: m.id,
        subject: m.subject,
        from: `${m.fromName} <${m.fromEmail}>`,
        to: m.to,
        date: m.date,
        att: m.hasAttachments,
        cls: m.messageClass,
      }
      // Bodies are the expensive part, so sample unless --full. A wrong-message
      // bug shows up in the metadata too, but the body hash is what proves the
      // content actually belongs to this message.
      if (hashEveryBody || i % 10 === 0) {
        const content = await api.getMessageContent(sourceId, m.id)
        row.body = sha(content ? `${content.html ?? ''}${content.text ?? ''}` : '')
        row.atts = (content?.attachments ?? []).map((a) => a.name).join('|')
        bodies++
      }
      rows.push(row)
      messages++
    }
    folders.push({ name: folder.name, id: folder.id, unreadable, rows })
  }
  return { file: basename(mailboxPath), full: hashEveryBody, messages, bodies, folders }
}

/** Report the first differences in a form that points straight at the cause. */
function diff(baseline, current) {
  const problems = []
  if (baseline.messages !== current.messages) {
    problems.push(`message count: baseline ${baseline.messages}, now ${current.messages}`)
  }
  if (baseline.folders.length !== current.folders.length) {
    problems.push(`folder count: baseline ${baseline.folders.length}, now ${current.folders.length}`)
  }
  for (const [f, oldFolder] of baseline.folders.entries()) {
    const newFolder = current.folders[f]
    if (!newFolder) break
    if (oldFolder.rows.length !== newFolder.rows.length) {
      problems.push(
        `${oldFolder.name}: ${oldFolder.rows.length} messages in baseline, ${newFolder.rows.length} now`,
      )
    }
    const n = Math.min(oldFolder.rows.length, newFolder.rows.length)
    for (let i = 0; i < n; i++) {
      const a = oldFolder.rows[i]
      const b = newFolder.rows[i]
      for (const key of Object.keys(a)) {
        if (JSON.stringify(a[key]) !== JSON.stringify(b[key])) {
          problems.push(
            `${oldFolder.name}[${i}] ${key}: ${JSON.stringify(a[key])} -> ${JSON.stringify(b[key])}`,
          )
          break
        }
      }
      if (problems.length > 30) return problems
    }
  }
  return problems
}

const t0 = Date.now()
const api = await loadWorkerApi()
const blob = await openAsBlob(mailboxPath)
const file = new File([blob], basename(mailboxPath))

// Standalone messages open as a synthetic mailbox, the same as dropping them
// on the app; everything after this point is identical for both.
const standalone = /\.(msg|eml)$/i.test(mailboxPath)
await mkdir(BASELINE_DIR, { recursive: true })
const baselinePath = join(BASELINE_DIR, `${basename(mailboxPath)}.json`)

let baseline
if (!update) {
  try {
    baseline = JSON.parse(await readFile(baselinePath, 'utf8'))
  } catch {
    console.error(
      `no baseline for ${basename(mailboxPath)}. Record one first:\n` +
        `  node scripts/fidelity.mjs ${mailboxPath} --update`,
    )
    process.exit(2)
  }
}

// A check samples bodies exactly as its baseline did, otherwise rows would
// differ only because one side hashed more of them than the other. A baseline
// that predates this is rejected rather than compared: it would fail on every
// unsampled row and read like a real regression.
if (!update && typeof baseline.full !== 'boolean') {
  console.error(
    `baseline for ${basename(mailboxPath)} was written by an older version and cannot be compared.\n` +
      `  node scripts/fidelity.mjs ${mailboxPath} --update`,
  )
  process.exit(2)
}
const hashEveryBody = update ? full : baseline.full === true

const index = standalone
  ? await api.openMsgSource('fidelity', [file])
  : await api.openSource('fidelity', file)
await api.indexSource('fidelity')
const current = await snapshot(api, 'fidelity', index, hashEveryBody)
const secs = ((Date.now() - t0) / 1000).toFixed(1)

if (update) {
  await writeFile(baselinePath, JSON.stringify(current, null, 1))
  console.log(
    `baseline written: ${current.messages} messages in ${current.folders.length} folders ` +
      `(${current.bodies} bodies hashed) in ${secs}s\n  ${baselinePath}`,
  )
  process.exit(0)
}

const problems = diff(baseline, current)
if (problems.length === 0) {
  console.log(
    `FIDELITY OK: ${current.messages} messages in ${current.folders.length} folders ` +
      `match the baseline exactly (${current.bodies} bodies hashed, ${secs}s)`,
  )
  process.exit(0)
}
console.error(`FIDELITY FAILED for ${basename(mailboxPath)} — ${problems.length} difference(s):`)
for (const p of problems.slice(0, 30)) console.error('  ' + p)
process.exit(1)
