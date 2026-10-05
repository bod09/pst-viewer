// @vitest-environment jsdom
import { describe, expect, test } from 'vitest'
import { buildPrintDocument } from '../../src/lib/printExport'
import { PNG } from '../support/fixtures.mjs'
import { messageContent } from '../support/content'

const print = (overrides: Parameters<typeof messageContent>[0], allowRemote = true) =>
  new DOMParser().parseFromString(buildPrintDocument([messageContent(overrides)], allowRemote), 'text/html')

describe('buildPrintDocument', () => {
  test('shows the header fields and the plain text body', () => {
    const doc = print({
      subject: 'Quarterly zebra report',
      fromName: 'Alice Example',
      fromEmail: 'alice@example.com',
      to: [{ name: 'Bob Tester', email: 'bob@example.com' }, { name: '', email: 'eve@example.com' }],
      cc: [{ name: 'Carol Sender', email: '' }],
      date: new Date(2024, 2, 12, 10, 15).getTime(),
      text: 'Line one\nLine two',
      attachments: [
        { index: 0, name: 'chart.png', size: 10, mime: 'image/png', isInline: false, isEmbeddedMessage: false },
        { index: 1, name: 'logo.png', size: 10, mime: 'image/png', isInline: true, cid: 'logo', isEmbeddedMessage: false },
        { index: 2, name: 'Forwarded.eml', size: 10, mime: 'message/rfc822', isInline: true, isEmbeddedMessage: true },
      ],
    })
    expect(doc.querySelector('h1')?.textContent).toBe('Quarterly zebra report')
    const meta = [...doc.querySelectorAll('.meta')].map((m) => m.textContent)
    expect(meta[0]).toBe('From: Alice Example <alice@example.com>')
    expect(meta[1]).toBe('To: Bob Tester <bob@example.com>; eve@example.com')
    expect(meta[2]).toBe('Cc: Carol Sender')
    expect(meta[3]).toMatch(/^Date: .*2024/)
    // Inline pictures are part of the body, not listed; an attached message is.
    expect(meta[4]).toBe('Attachments: chart.png, Forwarded.eml')
    expect(doc.querySelector('pre.plain')?.textContent).toBe('Line one\nLine two')
  })

  test('one section per message', () => {
    const html = buildPrintDocument([messageContent({ subject: 'One' }), messageContent({ subject: 'Two' })])
    const doc = new DOMParser().parseFromString(html, 'text/html')
    expect([...doc.querySelectorAll('section.email h1')].map((h) => h.textContent)).toEqual(['One', 'Two'])
  })

  test('markup in any field is shown as text, never run', () => {
    const attack = '<img src=x onerror=alert(1)><script>alert(1)</script>'
    const doc = print({
      subject: attack,
      fromName: attack,
      fromEmail: `"><script>alert(2)</script>`,
      to: [{ name: attack, email: attack }],
      cc: [{ name: attack, email: '' }],
      text: `</pre>${attack}`,
      attachments: [{ index: 0, name: attack, size: 1, mime: '', isInline: false, isEmbeddedMessage: false }],
    })
    expect(doc.querySelectorAll('script')).toHaveLength(0)
    expect(doc.querySelectorAll('img')).toHaveLength(0)
    expect(doc.querySelectorAll('[onerror]')).toHaveLength(0)
    expect(doc.querySelector('h1')?.textContent).toBe(attack)
    expect(doc.querySelector('pre.plain')?.textContent).toBe(`</pre>${attack}`)
  })

  test('an html body is sanitised on the way in', () => {
    const doc = print({
      html: '<p onclick="alert(1)">Body</p><script>alert(1)</script><iframe src="https://tracker.example/"></iframe>',
    })
    expect(doc.querySelector('.email-body p')?.textContent).toBe('Body')
    expect(doc.querySelectorAll('script, iframe, [onclick]')).toHaveLength(0)
  })

  test('a style block cannot close itself and start markup', () => {
    // The printed page re-emits the message's CSS inside its own <style>.
    const doc = print({
      html: '<html><head><style>p { color: red } </style><script>alert(1)</script><style> b { color: blue }</style></head><body><p>x</p></body></html>',
    })
    expect(doc.querySelectorAll('script')).toHaveLength(0)
    const viaCss = print({
      html: '<style>p::after { content: "</style><img src=x onerror=alert(1)>" }</style><p>x</p>',
    })
    // The parser ends the style at the first "</style>", so the image is an
    // ordinary element of the message: kept, with its handler removed.
    expect(viaCss.querySelectorAll('[onerror], script')).toHaveLength(0)
    expect(viaCss.querySelectorAll('.email-body img')).toHaveLength(1)
    expect(viaCss.querySelector('.email-body p')?.textContent).toBe('x')
  })

  test('a style block inside svg is not carried into the page\'s own', () => {
    const doc = print({
      html: '<svg><style>&lt;/style&gt;&lt;img src=x onerror=alert(1)&gt;</style></svg><p>x</p>',
    })
    expect(doc.querySelectorAll('img, [onerror], script')).toHaveLength(0)
  })

  test('inline pictures are embedded, so they survive into the printed page', () => {
    const doc = print({
      html: '<img src="cid:chart">',
      inlineImages: [{ cid: 'chart', mime: 'image/png', data: PNG.slice().buffer }],
    })
    expect(doc.querySelector('.email-body img')?.getAttribute('src')).toBe(
      `data:image/png;base64,${Buffer.from(PNG).toString('base64')}`,
    )
  })

  test('remote pictures follow the reader\'s setting', () => {
    const html = '<img src="https://tracker.example/photo.jpg" width="100">'
    expect(print({ html }, true).querySelector('.email-body img')?.getAttribute('src')).toBe(
      'https://tracker.example/photo.jpg',
    )
    expect(print({ html }, false).querySelector('.email-body img')?.hasAttribute('src')).toBe(false)
  })

  test('a message with no sender says so', () => {
    expect(print({ fromName: '', fromEmail: '' }).querySelector('.meta')?.textContent).toBe('From: (unknown sender)')
  })
})
