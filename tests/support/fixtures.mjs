// @ts-check
/**
 * Made-up mail for tests.
 *
 * Real mail cannot go in the repository, so every test that needs a message
 * builds one here: fictional people at example.com, a two pixel image, and
 * distinctive words to search for. `npm run fixtures` writes the same files to
 * disk (scripts/make-fixtures.mjs) for trying things by hand.
 *
 * This is plain JavaScript, not TypeScript, so that script can import it
 * without a build step. The types are in the JSDoc comments.
 */
import { createRequire } from 'node:module'
import { zipSync } from 'fflate'

const require = createRequire(import.meta.url)
/** @type {typeof import('cfb')} */
const CFB = require('cfb')

/** A 2x2 PNG, so an image attachment exists for the OCR path to find. */
export const PNG = new Uint8Array(
  Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEUlEQVR4nGP8//8/AzbAhFVkuIsDAK2eBP+3XiBjAAAAAElFTkSuQmCC',
    'base64',
  ),
)

/** @param {Uint8Array} bytes */
export const base64 = (bytes) => Buffer.from(bytes).toString('base64')

/** UTF-8 bytes of lines joined the way mail is written: CRLF. */
/** @param {string[]} lines @returns {Uint8Array} */
export const crlf = (lines) => new Uint8Array(Buffer.from(lines.join('\r\n')))

/** An ordinary message with one image attachment. */
export function mailEml() {
  return crlf([
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
    base64(PNG),
    '',
    '--BOUND1--',
    '',
  ])
}

/**
 * Encoded words that try to pass off a different address as the sender (and
 * as a recipient), next to an encoded name that is entirely legitimate. The
 * addresses shown must be the ones outside the encoded words.
 */
export function spoofSenderEml() {
  return crlf([
    'From: =?UTF-8?Q?IT_Support_<helpdesk@company.example>?= <attacker@evil.example>',
    'To: =?UTF-8?B?w4lsb8Ovc2U=?= <eloise@example.com>, =?UTF-8?Q?Boss_<ceo@company.example>?= <intern@example.com>',
    'Subject: Spoofed sender test',
    'Date: Tue, 12 Mar 2024 11:00:00 +0000',
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    '',
    'The sender and second recipient carry a different address inside their names.',
    '',
  ])
}

/**
 * An HTML message carrying everything a hostile sender might try: script in
 * several disguises, a form, a frame, and remote content that would report
 * the message being opened. Each piece has a marker a test can look for.
 *
 * `remote` is the origin the remote content points at, so a browser test can
 * aim it at a server it controls and see whether anything arrives.
 *
 * @param {{ remote?: string }} [options]
 */
export function hostileHtmlEml({ remote = 'https://tracker.example' } = {}) {
  const html = [
    '<html><head>',
    // (An @import only counts when it comes first in a stylesheet.)
    `<style>@import url(${remote}/import.css); body { background: url(${remote}/style-bg.png) }</style>`,
    `<link rel="stylesheet" href="${remote}/sheet.css">`,
    '</head><body>',
    '<p id="visible">Visible paragraph: kumquat.</p>',
    '<script>window.parent.postMessage("pwned-script", "*"); document.title = "pwned-script"</script>',
    '<img src="x" onerror="window.parent.postMessage(\'pwned-onerror\', \'*\')">',
    '<a id="js-link" href="javascript:window.parent.postMessage(\'pwned-href\', \'*\')">javascript link</a>',
    '<a id="real-link" href="https://example.com/page">ordinary link</a>',
    '<svg width="120" height="30"><a id="svg-link" href="https://example.com/svg"><text x="0" y="20">svg link</text></a></svg>',
    `<iframe src="${remote}/frame.html"></iframe>`,
    `<form action="${remote}/submit"><input name="password"><button>Send</button></form>`,
    '<svg><script>window.parent.postMessage("pwned-svg", "*")</script></svg>',
    `<img id="remote-image" src="${remote}/picture.png" width="120" height="80" alt="remote">`,
    `<img id="tracking-pixel" src="${remote}/pixel.gif" width="1" height="1">`,
    `<div id="bg" style="background-image: url('${remote}/inline-bg.png')">styled</div>`,
    `<table background="${remote}/table-bg.png"><tr><td>cell</td></tr></table>`,
    '<img id="inline-image" src="cid:inline-chart" alt="inline">',
    '</body></html>',
  ].join('\n')
  return crlf([
    'From: Mallory Example <mallory@example.com>',
    'To: Bob Tester <bob@example.com>',
    'Subject: Hostile markup test',
    'Date: Wed, 13 Mar 2024 09:30:00 +0000',
    'MIME-Version: 1.0',
    'Content-Type: multipart/related; boundary="REL1"',
    '',
    '--REL1',
    'Content-Type: text/html; charset=utf-8',
    '',
    html,
    '',
    '--REL1',
    'Content-Type: image/png',
    'Content-ID: <inline-chart>',
    'Content-Disposition: inline',
    'Content-Transfer-Encoding: base64',
    '',
    base64(PNG),
    '',
    '--REL1--',
    '',
  ])
}

/**
 * A message with another message attached to it (message/rfc822), which in
 * turn has a file attached: the shape of a forwarded mail.
 */
export function forwardedEml() {
  const inner = [
    'From: Dave Inner <dave@example.com>',
    'To: Alice Example <alice@example.com>',
    'Subject: Original walrus memo',
    'Date: Mon, 11 Mar 2024 08:00:00 +0000',
    'MIME-Version: 1.0',
    'Content-Type: multipart/mixed; boundary="INNER1"',
    '',
    '--INNER1',
    'Content-Type: text/plain; charset=utf-8',
    '',
    'Inner body. Distinctive keyword: persimmon.',
    '',
    '--INNER1',
    'Content-Type: text/csv; name="figures.csv"',
    'Content-Disposition: attachment; filename="figures.csv"',
    '',
    'walrus,count',
    'atlantic,12',
    '',
    '--INNER1--',
    '',
  ]
  return crlf([
    'From: Alice Example <alice@example.com>',
    'To: Bob Tester <bob@example.com>',
    'Cc: Carol Sender <carol@example.com>',
    'Subject: Fwd: Original walrus memo',
    'Date: Tue, 12 Mar 2024 12:00:00 +0000',
    'Importance: high',
    'MIME-Version: 1.0',
    'Content-Type: multipart/mixed; boundary="OUTER1"',
    '',
    '--OUTER1',
    'Content-Type: text/plain; charset=utf-8',
    '',
    'Forwarding the memo. Distinctive keyword: quince.',
    '',
    '--OUTER1',
    'Content-Type: message/rfc822; name="Original walrus memo.eml"',
    'Content-Disposition: attachment; filename="Original walrus memo.eml"',
    '',
    ...inner,
    '--OUTER1--',
    '',
  ])
}

/**
 * A simple text message, for tests that need several different ones.
 *
 * @param {{ from?: string, to?: string, cc?: string, subject: string, date?: string,
 *           body?: string, headers?: string[] }} options
 */
export function simpleEml({
  from = 'Alice Example <alice@example.com>',
  to = 'Bob Tester <bob@example.com>',
  cc,
  subject,
  date = 'Tue, 12 Mar 2024 10:15:00 +0000',
  body = 'Plain body.',
  headers = [],
}) {
  return crlf([
    `From: ${from}`,
    `To: ${to}`,
    ...(cc ? [`Cc: ${cc}`] : []),
    `Subject: ${subject}`,
    `Date: ${date}`,
    ...headers,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    '',
    body,
    '',
  ])
}

/**
 * A .msg file. It is a CFB (OLE compound) file: one stream per property, plus
 * a header listing them. Only Unicode string properties are written, which is
 * all a readable message needs.
 *
 * @param {{ subject?: string, body?: string, senderName?: string, senderEmail?: string,
 *           messageClass?: string }} [options]
 * @returns {Uint8Array}
 */
export function mailMsg({
  subject = 'Distinctive msg subject wombat',
  body = 'Body of the msg file. Distinctive keyword: pomegranate.',
  senderName = 'Carol Sender',
  senderEmail = 'carol@example.com',
  messageClass = 'IPM.Note',
} = {}) {
  /** @type {Record<string, Buffer>} */
  const streams = {}
  /** @type {Buffer[]} */
  const props = []
  /** @param {number} tag @param {string} value */
  const addString = (tag, value) => {
    const data = Buffer.from(value, 'utf16le')
    streams[`__substg1.0_${tag.toString(16).toUpperCase().padStart(8, '0')}`] = data
    const entry = Buffer.alloc(16)
    entry.writeUInt32LE(tag, 0) // property tag, type 001F = unicode string
    entry.writeUInt32LE(6, 4) // flags: readable | writable
    entry.writeUInt32LE(data.length + 2, 8) // size including the terminator
    props.push(entry)
  }
  addString(0x0037001f, subject)
  addString(0x1000001f, body)
  addString(0x0c1a001f, senderName)
  addString(0x5d01001f, senderEmail)
  addString(0x001a001f, messageClass)

  const cfb = CFB.utils.cfb_new()
  CFB.utils.cfb_add(cfb, '/__properties_version1.0', Buffer.concat([Buffer.alloc(32), ...props]))
  for (const [name, data] of Object.entries(streams)) CFB.utils.cfb_add(cfb, '/' + name, data)
  return new Uint8Array(CFB.write(cfb, { type: 'buffer' }))
}

/**
 * A zip archive of the given entries (path to bytes).
 *
 * @param {Record<string, Uint8Array>} entries
 * @returns {Uint8Array}
 */
export function zip(entries) {
  // A fixed timestamp, so the same entries always give the same bytes.
  return zipSync(entries, { mtime: new Date(2024, 2, 12, 12, 0, 0) })
}

/** A zip holding one .eml and one .msg, for the archive path. */
export function batchZip() {
  return zip({ 'mail.eml': mailEml(), 'mail.msg': mailMsg() })
}

/**
 * The files `npm run fixtures` writes, by name.
 *
 * @returns {Record<string, Uint8Array>}
 */
export function fixtureFiles() {
  return {
    'mail.eml': mailEml(),
    'spoof-sender.eml': spoofSenderEml(),
    'hostile-html.eml': hostileHtmlEml(),
    'forwarded.eml': forwardedEml(),
    'mail.msg': mailMsg(),
    'batch.zip': batchZip(),
  }
}
