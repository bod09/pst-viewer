import { describe, expect, test } from 'vitest'
import { extractMimeBody } from '../../src/lib/mime'
import { PNG, base64, crlf } from '../support/fixtures.mjs'

const latin1 = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0))
const text = (data: ArrayBuffer) => new TextDecoder().decode(data)

describe('extractMimeBody', () => {
  test('a plain text message', () => {
    const body = extractMimeBody(crlf(['Content-Type: text/plain; charset=utf-8', '', 'Hello café', '']))
    expect(body).toEqual({ html: null, text: 'Hello café', attachments: [] })
  })

  test('no content type means plain text', () => {
    expect(extractMimeBody(crlf(['Subject: x', '', 'just text'])).text).toBe('just text')
  })

  test('an html message', () => {
    const body = extractMimeBody(crlf(['Content-Type: text/html', '', '<p>Hi</p>']))
    expect(body.html).toBe('<p>Hi</p>')
    expect(body.text).toBeNull()
  })

  test('bare line feeds work as well as CRLF', () => {
    const raw = new TextEncoder().encode('Content-Type: text/plain\n\nunix body\n')
    expect(extractMimeBody(raw).text).toBe('unix body')
  })

  test('base64 and quoted-printable bodies are decoded in their own charset', () => {
    const b64 = extractMimeBody(
      crlf([
        'Content-Type: text/plain; charset="utf-8"',
        'Content-Transfer-Encoding: base64',
        '',
        Buffer.from('Grüße aus Köln').toString('base64'),
      ]),
    )
    expect(b64.text).toBe('Grüße aus Köln')

    const qp = extractMimeBody(
      latin1(
        'Content-Type: text/plain; charset=iso-8859-1\r\n' +
          'Content-Transfer-Encoding: quoted-printable\r\n\r\n' +
          'Caf=E9 au lait, soft=\r\nbreak joined',
      ),
    )
    expect(qp.text).toBe('Café au lait, softbreak joined')

    // Shift-JIS bytes for "日本語".
    const sjis = new Uint8Array([
      ...latin1('Content-Type: text/plain; charset=shift_jis\r\n\r\n'),
      0x93, 0xfa, 0x96, 0x7b, 0x8c, 0xea,
    ])
    expect(extractMimeBody(sjis).text).toBe('日本語')
  })

  test('an unknown charset falls back to UTF-8 rather than failing', () => {
    const body = extractMimeBody(crlf(['Content-Type: text/plain; charset=x-no-such-charset', '', 'still here']))
    expect(body.text).toBe('still here')
  })

  test('alternative parts: the last usable version of each kind wins', () => {
    const body = extractMimeBody(
      crlf([
        'Content-Type: multipart/alternative; boundary="ALT"',
        '',
        '--ALT',
        'Content-Type: text/plain',
        '',
        'plain version',
        '--ALT',
        'Content-Type: text/html',
        '',
        '<p>html version</p>',
        '--ALT--',
        '',
      ]),
    )
    expect(body.text).toBe('plain version')
    expect(body.html).toBe('<p>html version</p>')
  })

  test('mixed parts: the first body is the body, attached files are carried out', () => {
    const body = extractMimeBody(
      crlf([
        'Content-Type: multipart/mixed; boundary=MIX',
        '',
        'preamble that is not part of the message',
        '--MIX',
        'Content-Type: multipart/alternative; boundary="ALT"',
        '',
        '--ALT',
        'Content-Type: text/plain',
        '',
        'the body',
        '--ALT',
        'Content-Type: text/html',
        '',
        '<p>the body</p>',
        '--ALT--',
        '--MIX',
        'Content-Type: text/plain; name="notes.txt"',
        'Content-Disposition: attachment; filename="Meeting Notes.TXT"',
        '',
        'an attached text file, not the body',
        '--MIX',
        'Content-Type: image/png; name="chart.png"',
        'Content-Transfer-Encoding: base64',
        'Content-ID: <chart@example.com>',
        '',
        base64(PNG),
        '--MIX',
        'Content-Type: application/octet-stream',
        'Content-Disposition: attachment',
        'Content-Transfer-Encoding: quoted-printable',
        '',
        'a=3Db',
        '--MIX--',
        'epilogue',
      ]),
    )
    expect(body.text).toBe('the body')
    expect(body.html).toBe('<p>the body</p>')
    expect(body.attachments.map((a) => [a.name, a.mime, a.cid])).toEqual([
      // The name keeps the case it was written in.
      ['Meeting Notes.TXT', 'text/plain', ''],
      ['chart.png', 'image/png', 'chart@example.com'],
      ['attachment', 'application/octet-stream', ''],
    ])
    expect(text(body.attachments[0].data)).toBe('an attached text file, not the body')
    expect(new Uint8Array(body.attachments[1].data)).toEqual(PNG)
    expect(text(body.attachments[2].data)).toBe('a=b')
  })

  test('a boundary string inside a part does not split it', () => {
    const body = extractMimeBody(
      crlf([
        'Content-Type: multipart/mixed; boundary="B"',
        '',
        '--B',
        'Content-Type: text/plain',
        '',
        'this line mentions --B in the middle and stays whole',
        '--B--',
      ]),
    )
    expect(body.text).toBe('this line mentions --B in the middle and stays whole')
  })

  test('a boundary with characters special to a pattern is taken literally', () => {
    const body = extractMimeBody(
      crlf([
        'Content-Type: multipart/mixed; boundary="=_(a+b)*.?[x]"',
        '',
        '--=_(a+b)*.?[x]',
        'Content-Type: text/plain',
        '',
        'body',
        '--=_(a+b)*.?[x]--',
      ]),
    )
    expect(body.text).toBe('body')
  })

  test('damaged input gives an empty result, never an error', () => {
    const empty = { html: null, text: null, attachments: [] }
    expect(extractMimeBody(new Uint8Array(0))).toEqual(empty)
    expect(extractMimeBody(latin1('no blank line anywhere'))).toEqual(empty)
    expect(extractMimeBody(crlf(['Content-Type: multipart/mixed', '', '--X', '', 'no boundary named']))).toEqual(empty)
    expect(
      extractMimeBody(
        crlf(['Content-Type: multipart/mixed; boundary=B', '', '--B', 'Content-Disposition: attachment', 'Content-Transfer-Encoding: base64', '', '!!!not base64!!!', '--B--']),
      ),
    ).toEqual(empty)
  })

  test('a message nested without end stops instead of running away', () => {
    // Each level wraps the next in another multipart with the same boundary.
    let raw = 'Content-Type: text/plain\r\n\r\ndeepest'
    for (let i = 0; i < 40; i++) {
      raw = `Content-Type: multipart/mixed; boundary="L${i}"\r\n\r\n--L${i}\r\n${raw}\r\n--L${i}--\r\n`
    }
    expect(extractMimeBody(latin1(raw))).toEqual({ html: null, text: null, attachments: [] })
  })
})
