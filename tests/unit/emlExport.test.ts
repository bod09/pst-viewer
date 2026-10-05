import PostalMime from 'postal-mime'
import { describe, expect, test } from 'vitest'
import { emlFilename, emlParts, type EmlAttachment } from '../../src/lib/emlExport'
import { structuredAddresses } from '../../src/worker/eml'
import { PNG } from '../support/fixtures.mjs'
import { messageContent } from '../support/content'

const build = (content = messageContent(), attachments: EmlAttachment[] = []) =>
  [...emlParts(content, attachments)].join('')

/** Read a built .eml back with an independent parser. */
const parse = (eml: string) =>
  PostalMime.parse(eml, { attachmentEncoding: 'arraybuffer', rfc822Attachments: true })

const bytesOf = (content: unknown) => new Uint8Array(content as ArrayBuffer)

/** Deterministic bytes that are not valid UTF-8 and cover every value. */
function noise(length: number): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(length)
  let x = 0x2545f491
  for (let i = 0; i < length; i++) {
    x ^= x << 13
    x ^= x >>> 17
    x ^= x << 5
    out[i] = x & 0xff
  }
  return out
}

const attachment = (name: string, data: Uint8Array<ArrayBuffer>, mime = ''): EmlAttachment => ({
  name,
  mime,
  data: data.buffer,
})

describe('headers', () => {
  test('are synthesised from the fields when the message has none', () => {
    const eml = build(
      messageContent({
        subject: 'Zebra report',
        fromName: 'Alice Example',
        fromEmail: 'alice@example.com',
        to: [{ name: 'Bob Tester', email: 'bob@example.com' }, { name: '', email: 'eve@example.com' }],
        cc: [{ name: 'Carol Sender', email: 'carol@example.com' }],
        date: Date.UTC(2024, 2, 12, 10, 15, 0),
      }),
    )
    const head = eml.slice(0, eml.indexOf('\r\n\r\n'))
    expect(head.split('\r\n')).toEqual([
      'From: Alice Example <alice@example.com>',
      'To: Bob Tester <bob@example.com>, <eve@example.com>',
      'Cc: Carol Sender <carol@example.com>',
      'Subject: Zebra report',
      'Date: Tue, 12 Mar 2024 10:15:00 +0000',
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset="utf-8"',
      'Content-Transfer-Encoding: base64',
    ])
  })

  test('non-ASCII names and subjects become encoded words a parser reads back', async () => {
    const email = await parse(
      build(
        messageContent({
          subject: 'Réunion à 15h – été',
          fromName: 'Éloïse Dupont',
          fromEmail: 'eloise@example.com',
          to: [{ name: '田中太郎', email: 'tanaka@example.com' }],
        }),
      ),
    )
    expect(email.subject).toBe('Réunion à 15h – été')
    expect(email.from).toEqual({ name: 'Éloïse Dupont', address: 'eloise@example.com' })
    expect(email.to).toEqual([{ name: '田中太郎', address: 'tanaka@example.com' }])
  })

  test('a line break in a field cannot start a new header', () => {
    const eml = build(
      messageContent({
        subject: 'Hello\r\nBcc: hidden@example.com',
        fromName: 'Mallory\r\nX-Injected: 1',
        fromEmail: 'mallory@example.com>\r\nX-Injected: 2\r\n\r\nbody',
        to: [{ name: 'Bob\nX-Injected: 3', email: 'bob@example.com\r\nX-Injected: 4' }],
      }),
    )
    const head = eml.slice(0, eml.indexOf('\r\n\r\n'))
    const names = head.split('\r\n').map((line) => line.slice(0, line.indexOf(':')))
    expect(names).toEqual([
      'From',
      'To',
      'Subject',
      'MIME-Version',
      'Content-Type',
      'Content-Transfer-Encoding',
    ])
  })

  test('punctuation in a name stays part of the name when read back', async () => {
    const eml = build(
      messageContent({
        fromName: 'IT Support <helpdesk@company.example>',
        fromEmail: 'attacker@evil.example',
        to: [
          { name: 'Smith, John', email: 'john@example.com' },
          { name: 'Quote "Q" Back\\slash', email: 'quote@example.com' },
          { name: 'Boss <ceo@company.example>, Other <x@example.com>', email: '' },
        ],
      }),
    )
    const email = await parse(eml)
    expect(email.from).toEqual({
      name: 'IT Support <helpdesk@company.example>',
      address: 'attacker@evil.example',
    })
    // The last recipient has no address at all. It stays one recipient: the
    // addresses inside its name do not become recipients of their own. (A
    // parser has nowhere to put a name on its own, so it lands in `address`.)
    expect(email.to).toEqual([
      { name: 'Smith, John', address: 'john@example.com' },
      { name: 'Quote "Q" Back\\slash', address: 'quote@example.com' },
      { name: '', address: 'Boss <ceo@company.example>, Other <x@example.com>' },
    ])
    // And the app's own reader agrees (it does not trust postal-mime here).
    const header = (name: string) => new RegExp(`^${name}: (.*)$`, 'm').exec(eml)?.[1] ?? ''
    expect(structuredAddresses(header('From'))).toEqual([email.from])
    expect(structuredAddresses(header('To'))).toEqual(email.to)
  })

  test('the real transport headers are kept, minus the ones describing the old body', () => {
    const eml = build(
      messageContent({
        subject: 'ignored when headers exist',
        headers: [
          'Microsoft Mail Internet Headers Version 2.0',
          'Received: from mail.example.com (mail.example.com [192.0.2.1])',
          '\tby mx.example.org with ESMTP id abc123;',
          '\tTue, 12 Mar 2024 10:15:02 +0000',
          'DKIM-Signature: v=1; a=rsa-sha256; d=example.com;',
          ' b=abcdef',
          'From: Alice Example <alice@example.com>',
          'Subject: =?UTF-8?B?UsOpdW5pb24=?=',
          'Content-Type: multipart/mixed;',
          '\tboundary="old-boundary"',
          'Content-Transfer-Encoding: 7bit',
          'MIME-Version: 1.0',
          'Content-Disposition: inline',
          'Content-ID: <old@example.com>',
          'this line is not a header at all',
          ' and neither is its continuation',
          'X-Mailer: Example Mailer 1.0',
          '',
        ].join('\r\n'),
      }),
    )
    const head = eml.slice(0, eml.indexOf('\r\n\r\n'))
    expect(head.split('\r\n')).toEqual([
      'Received: from mail.example.com (mail.example.com [192.0.2.1])',
      '\tby mx.example.org with ESMTP id abc123;',
      '\tTue, 12 Mar 2024 10:15:02 +0000',
      'DKIM-Signature: v=1; a=rsa-sha256; d=example.com;',
      ' b=abcdef',
      'From: Alice Example <alice@example.com>',
      'Subject: =?UTF-8?B?UsOpdW5pb24=?=',
      'X-Mailer: Example Mailer 1.0',
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset="utf-8"',
      'Content-Transfer-Encoding: base64',
    ])
  })

  test('headers written with bare line feeds come out with CRLF', () => {
    const eml = build(
      messageContent({ headers: 'From: alice@example.com\nSubject: Bare\n continuation\n' }),
    )
    expect(eml.startsWith('From: alice@example.com\r\nSubject: Bare\r\n continuation\r\nMIME-Version')).toBe(true)
  })
})

describe('body', () => {
  test('text only', async () => {
    const email = await parse(build(messageContent({ text: 'Plain café body\nline two', html: null })))
    expect(email.text).toBe('Plain café body\nline two')
    expect(email.html).toBeUndefined()
  })

  test('html only', async () => {
    const email = await parse(build(messageContent({ text: null, html: '<p>Hello <b>wörld</b></p>' })))
    expect(email.html).toBe('<p>Hello <b>wörld</b></p>')
  })

  test('text and html become alternatives of one another', async () => {
    const eml = build(messageContent({ text: 'plain version', html: '<p>html version</p>' }))
    expect(eml).toMatch(/Content-Type: multipart\/alternative; boundary="/)
    const email = await parse(eml)
    expect(email.text).toBe('plain version')
    expect(email.html).toBe('<p>html version</p>')
    expect(email.attachments).toEqual([])
  })

  test('a message with no body at all is still a valid message', async () => {
    const email = await parse(build(messageContent({ text: null, html: null, subject: 'Empty' })))
    expect(email.subject).toBe('Empty')
    expect(email.text ?? '').toBe('')
  })

  test('inline images travel as related parts with their content id', async () => {
    const eml = build(
      messageContent({
        html: '<p>Chart: <img src="cid:chart@example.com"></p>',
        inlineImages: [{ cid: 'chart@example.com', mime: 'image/png', data: PNG.slice().buffer }],
      }),
    )
    expect(eml).toMatch(/Content-Type: multipart\/related; boundary="/)
    const email = await parse(eml)
    expect(email.attachments).toHaveLength(1)
    const [image] = email.attachments
    expect(image.contentId).toBe('<chart@example.com>')
    expect(image.disposition).toBe('inline')
    expect(image.mimeType).toBe('image/png')
    expect(bytesOf(image.content)).toEqual(PNG)
  })

  test('a content id cannot break out of its header', () => {
    const eml = build(
      messageContent({
        html: '<img src="cid:x">',
        inlineImages: [{ cid: 'x>\r\nX-Injected: 1\r\n\r\n<', mime: 'image/png', data: PNG.slice().buffer }],
      }),
    )
    expect(eml).toContain('Content-ID: <xX-Injected: 1>\r\n')
    expect(eml).not.toMatch(/^X-Injected/m)
  })
})

describe('attachments', () => {
  test('come back byte for byte, with their names and types', async () => {
    const data = noise(5000)
    const email = await parse(
      build(messageContent({ text: 'see attached' }), [
        attachment('report.bin', data, 'application/x-noise'),
        attachment('chart.png', PNG.slice(), 'image/png'),
      ]),
    )
    expect(email.text).toBe('see attached')
    expect(email.attachments.map((a) => [a.filename, a.mimeType, a.disposition])).toEqual([
      ['report.bin', 'application/x-noise', 'attachment'],
      ['chart.png', 'image/png', 'attachment'],
    ])
    expect(bytesOf(email.attachments[0].content)).toEqual(data)
    expect(bytesOf(email.attachments[1].content)).toEqual(PNG)
  })

  test('a missing name or type gets a safe default', async () => {
    const email = await parse(build(messageContent(), [attachment('', noise(10))]))
    expect(email.attachments[0].filename).toBe('attachment')
    expect(email.attachments[0].mimeType).toBe('application/octet-stream')
  })

  test('an empty attachment is kept as an empty file', async () => {
    const email = await parse(build(messageContent(), [attachment('empty.txt', new Uint8Array(0), 'text/plain')]))
    expect(email.attachments).toHaveLength(1)
    expect(email.attachments[0].filename).toBe('empty.txt')
    expect(bytesOf(email.attachments[0].content)).toHaveLength(0)
  })

  test('a non-ASCII name survives', async () => {
    const email = await parse(build(messageContent(), [attachment('Résumé – 田中.pdf', noise(64), 'application/pdf')]))
    expect(email.attachments[0].filename).toBe('Résumé – 田中.pdf')
  })

  test.each([
    ['a quote', 'evil".exe', 'evil_.exe'],
    [
      'a line break',
      'invoice.pdf\r\nContent-Type: text/html\r\n\r\n<script>alert(1)</script>',
      'invoice.pdf Content-Type: text/html <script>alert(1)</script>',
    ],
    ['a semicolon and a second parameter', 'a.txt; filename="b.exe"', 'a.txt; filename=_b.exe_'],
    ['a backslash', 'back\\slash".txt', 'back_slash_.txt'],
    ['a line break in a non-ASCII name', 'ré\r\nContent-Type: text/html', 'ré Content-Type: text/html'],
  ])('a name with %s cannot close its parameter or add a header', async (_what, name, readsBackAs) => {
    const data = noise(32)
    const eml = build(messageContent({ text: 'body' }), [attachment(name, data, 'application/octet-stream')])
    // Exactly the headers this code writes, and nothing the name smuggled in.
    const part = eml.slice(eml.lastIndexOf('Content-Type: application/octet-stream'))
    const head = part.slice(0, part.indexOf('\r\n\r\n')).split('\r\n')
    expect(head.map((line) => line.slice(0, line.indexOf(':')))).toEqual([
      'Content-Type',
      'Content-Transfer-Encoding',
      'Content-Disposition',
    ])
    const email = await parse(eml)
    expect(email.text).toBe('body')
    expect(email.html).toBeUndefined()
    expect(email.attachments).toHaveLength(1)
    expect(email.attachments[0].mimeType).toBe('application/octet-stream')
    // The whole name is still the name: nothing was cut off at a quote, and
    // nothing after it was read as another parameter.
    expect(email.attachments[0].filename).toBe(readsBackAs)
    expect(bytesOf(email.attachments[0].content)).toEqual(data)
  })

  // An attachment is encoded a piece at a time (57 * 32768 bytes each), and
  // the pieces must join into exactly the text one pass would have made.
  const PIECE = 57 * 32768
  test.each([
    ['one byte short of a piece', PIECE - 1],
    ['exactly one piece', PIECE],
    ['one byte into the second piece', PIECE + 1],
    ['two pieces and a bit', 2 * PIECE + 12345],
  ])('a large attachment survives being written in pieces: %s', async (_what, length) => {
    const data = noise(length)
    const parts = [...emlParts(messageContent(), [attachment('big.bin', data)])]
    const eml = parts.join('')
    const email = await parse(eml)
    const got = bytesOf(email.attachments[0].content)
    expect(got.length).toBe(length)
    expect(Buffer.from(got).equals(Buffer.from(data))).toBe(true)
    // A forgiving parser reads badly joined pieces too, so look at the text
    // itself: full 76-character lines, and padding only at the very end.
    const start = eml.indexOf('\r\n\r\n', eml.indexOf('filename="big.bin"')) + 4
    const lines = eml.slice(start, eml.indexOf('\r\n\r\n--', start)).split('\r\n')
    expect(lines.slice(0, -1).every((line) => line.length === 76 && !line.includes('='))).toBe(true)
    expect(lines.at(-1)).toMatch(/^[A-Za-z0-9+/]{1,76}={0,2}$/)
    expect(lines.join('')).toBe(Buffer.from(data).toString('base64'))
    // No single piece holds the whole attachment.
    expect(Math.max(...parts.map((p) => p.length))).toBeLessThan(PIECE * 1.4)
  })
})

describe('structure', () => {
  test('every line fits the lengths mail allows, and every boundary is closed', () => {
    const eml = build(
      messageContent({
        text: 'word '.repeat(2000),
        html: `<p>${'long '.repeat(2000)}</p>`,
        inlineImages: [{ cid: 'a', mime: 'image/png', data: PNG.slice().buffer }],
      }),
      [attachment('data.bin', noise(4000))],
    )
    const lines = eml.split('\r\n')
    // Nothing but CRLF line endings.
    expect(eml.replace(/\r\n/g, '')).not.toMatch(/[\r\n]/)
    // Base64 bodies are folded at 76; no line comes near the 998 limit.
    expect(Math.max(...lines.map((l) => l.length))).toBeLessThanOrEqual(120)
    const boundaries = [...eml.matchAll(/boundary="([^"]+)"/g)].map((m) => m[1])
    expect(boundaries).toHaveLength(3) // mixed, related, alternative
    expect(new Set(boundaries).size).toBe(3)
    for (const b of boundaries) expect(lines).toContain(`--${b}--`)
  })

  test('boundaries differ from one message to the next', () => {
    const boundaryOf = () => /boundary="([^"]+)"/.exec(build(messageContent(), [attachment('a', noise(3))]))?.[1]
    expect(boundaryOf()).not.toBe(boundaryOf())
  })
})

describe('emlFilename', () => {
  test.each([
    ['Quarterly zebra report', 'Quarterly_zebra_report.eml'],
    ['', 'message.eml'],
    ['///', 'message.eml'],
    ['../../etc/passwd', '.._.._etc_passwd.eml'],
    ['RE: C:\\Users\\bob', 'RE_C_Users_bob.eml'],
    ['Réunion été', 'R_union_t.eml'],
    ['a'.repeat(200), `${'a'.repeat(80)}.eml`],
  ])('%j becomes %j', (subject, expected) => {
    expect(emlFilename(subject)).toBe(expected)
  })
})
