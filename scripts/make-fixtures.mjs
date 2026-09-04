/**
 * Write small synthetic .msg / .eml / .zip files for testing.
 *
 * The fidelity check needs mail to run against, and real mail cannot go in the
 * repository. These are made up: fictional people at example.com, a two pixel
 * image, and distinctive words to search for. They are written to the path you
 * give (default ./fixtures), which is git-ignored.
 *
 *   node scripts/make-fixtures.mjs [outputDir]
 *   node scripts/fidelity.mjs fixtures/mail.eml --update --full
 */
import { createRequire } from 'node:module'
import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const CFB = require('cfb')

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const outDir = resolve(process.argv[2] ?? join(ROOT, 'fixtures'))
await mkdir(outDir, { recursive: true })

/** A 2x2 PNG, so an image attachment exists for the OCR path to find. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEUlEQVR4nGP8//8/AzbAhFVkuIsDAK2eBP+3XiBjAAAAAElFTkSuQmCC',
  'base64',
)

const eml = [
  'From: Alice Example <alice@example.com>',
  'To: Bob Tester <bob@example.com>',
  'Subject: Quarterly zebra report',
  'Date: Tue, 12 Mar 2024 10:15:00 +0000',
  'MIME-Version: 1.0',
  'Content-Type: multipart/mixed; boundary="BOUND1"',
  '',
  '--BOUND1',
  'Content-Type: text/plain; charset=utf-8',
  '',
  'The zebra migration figures are attached. Distinctive keyword: pomegranate.',
  '',
  '--BOUND1',
  'Content-Type: image/png; name="chart.png"',
  'Content-Disposition: attachment; filename="chart.png"',
  'Content-Transfer-Encoding: base64',
  '',
  PNG.toString('base64'),
  '',
  '--BOUND1--',
  '',
].join('\r\n')
await writeFile(join(outDir, 'mail.eml'), eml)

// A .msg is a CFB file: one stream per property, plus a header listing them.
const streams = {}
const props = []
const addString = (tag, value) => {
  const data = Buffer.from(value, 'utf16le')
  streams[`__substg1.0_${tag.toString(16).toUpperCase().padStart(8, '0')}`] = data
  const entry = Buffer.alloc(16)
  entry.writeUInt32LE(tag, 0) // property tag, type 001F = unicode string
  entry.writeUInt32LE(6, 4) // flags: readable | writable
  entry.writeUInt32LE(data.length + 2, 8) // size including the terminator
  props.push(entry)
}
addString(0x0037001f, 'Distinctive msg subject wombat')
addString(0x1000001f, 'Body of the msg file. Distinctive keyword: pomegranate.')
addString(0x0c1a001f, 'Carol Sender')
addString(0x5d01001f, 'carol@example.com')
addString(0x001a001f, 'IPM.Note')

const cfb = CFB.utils.cfb_new()
CFB.utils.cfb_add(cfb, '/__properties_version1.0', Buffer.concat([Buffer.alloc(32), ...props]))
for (const [name, data] of Object.entries(streams)) CFB.utils.cfb_add(cfb, '/' + name, data)
const msg = CFB.write(cfb, { type: 'buffer' })
await writeFile(join(outDir, 'mail.msg'), msg)

// A zip holding both, for the archive path.
const { zipSync } = await import('fflate')
const zip = zipSync({
  'mail.eml': new Uint8Array(Buffer.from(eml)),
  'mail.msg': new Uint8Array(msg),
})
await writeFile(join(outDir, 'batch.zip'), Buffer.from(zip))

console.log(`wrote mail.eml, mail.msg and batch.zip to ${outDir}`)
