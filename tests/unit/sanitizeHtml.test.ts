// @vitest-environment jsdom
import { describe, expect, test } from 'vitest'
import { sanitizeEmailHtml } from '../../src/lib/sanitizeHtml'

const REMOTE = 'https://tracker.example'
const noCids = new Map<string, string>()

const sanitize = (html: string, allowRemote = true, cids = noCids) =>
  sanitizeEmailHtml(html, cids, allowRemote)

/** The sanitised markup as a document, for looking at what survived. */
const dom = (html: string, allowRemote = true, cids = noCids) =>
  new DOMParser().parseFromString(sanitize(html, allowRemote, cids), 'text/html')

describe('script cannot survive', () => {
  // Each of these runs script in a browser if it reaches the page untouched.
  test.each([
    ['a script element', '<script>alert(1)</script>'],
    ['a script with a source', `<script src="${REMOTE}/x.js"></script>`],
    ['an event handler', '<img src="x" onerror="alert(1)">'],
    ['an event handler on the body', '<body onload="alert(1)"><p>x</p></body>'],
    ['a javascript: link', '<a href="javascript:alert(1)">x</a>'],
    ['a javascript: link hidden by a tab', '<a href="java\tscript:alert(1)">x</a>'],
    ['a javascript: link hidden by entities', '<a href="&#106;avascript:alert(1)">x</a>'],
    ['a vbscript: link', '<a href="vbscript:msgbox(1)">x</a>'],
    ['a data: page in a link', '<a href="data:text/html,<script>alert(1)</script>">x</a>'],
    ['script inside svg', '<svg><script>alert(1)</script></svg>'],
    ['an svg load handler', '<svg onload="alert(1)"></svg>'],
    ['an svg animation setting a handler', '<svg><animate onbegin="alert(1)" attributeName="x"></animate></svg>'],
    ['script inside math', '<math><mtext><script>alert(1)</script></mtext></math>'],
    ['a frame', `<iframe src="${REMOTE}/frame.html"></iframe>`],
    ['a frame with inline content', '<iframe srcdoc="<script>alert(1)</script>"></iframe>'],
    ['an object', `<object data="${REMOTE}/x.swf"></object>`],
    ['an embed', `<embed src="${REMOTE}/x.swf">`],
    ['a meta refresh', `<meta http-equiv="refresh" content="0;url=${REMOTE}/">`],
    ['a base element', `<base href="${REMOTE}/"><a href="/x">x</a>`],
    ['a form posting elsewhere', `<form action="${REMOTE}/steal"><input name="p"></form>`],
    ['a button with its own target', `<button formaction="${REMOTE}/steal">go</button>`],
    ['a noscript fallback', '<noscript><p title="</noscript><img src=x onerror=alert(1)>"></noscript>'],
    ['markup hidden in a comment', '<!--><script>alert(1)</script>-->'],
    ['a template', '<template><script>alert(1)</script></template>'],
  ])('%s', (_what, html) => {
    const out = sanitize(html)
    const doc = new DOMParser().parseFromString(out, 'text/html')
    expect(doc.querySelectorAll('script, iframe, object, embed, form, base, noscript')).toHaveLength(0)
    expect(doc.querySelector('meta[http-equiv="refresh" i]')).toBeNull()
    for (const el of doc.querySelectorAll('*')) {
      for (const attr of el.attributes) {
        expect(attr.name, `${el.localName} ${attr.name}`).not.toMatch(/^on/i)
        expect(attr.name).not.toBe('formaction')
        expect(attr.name).not.toBe('srcdoc')
      }
      const urls = [...el.attributes].filter((a) => ['href', 'src', 'action', 'xlink:href'].includes(a.name))
      for (const attr of urls) {
        expect(attr.value.replace(/\s/g, ''), `${el.localName} ${attr.name}`).not.toMatch(
          /^(javascript|vbscript|data:text\/html)/i,
        )
      }
    }
    expect(out).not.toMatch(/alert\(1\)|msgbox\(1\)/)
  })

  test('ordinary content is left as it was', () => {
    const doc = dom(
      '<html><head><style>.big { font-size: 20px }</style></head><body>' +
        '<h1 class="big" style="color: red">Title</h1><p>Text with <b>bold</b> and <i>italic</i>.</p>' +
        '<table><tr><td>cell</td></tr></table><ul><li>item</li></ul></body></html>',
    )
    expect(doc.querySelector('h1')?.getAttribute('style')).toBe('color: red')
    expect(doc.querySelector('style')?.textContent).toContain('font-size: 20px')
    expect(doc.body.textContent).toBe('TitleText with bold and italic.cellitem')
    expect(doc.querySelectorAll('table td, ul li, b, i')).toHaveLength(4)
  })
})

describe('links', () => {
  test('open in a new tab without telling the site where the reader came from', () => {
    const a = dom('<a href="https://example.com/page">x</a>').querySelector('a')
    expect(a?.getAttribute('href')).toBe('https://example.com/page')
    expect(a?.getAttribute('target')).toBe('_blank')
    expect(a?.getAttribute('rel')).toBe('noopener noreferrer nofollow')
  })

  test('a target the message chose is replaced', () => {
    const a = dom('<a href="https://example.com/" target="_top" rel="opener">x</a>').querySelector('a')
    expect(a?.getAttribute('target')).toBe('_blank')
    expect(a?.getAttribute('rel')).toBe('noopener noreferrer nofollow')
  })

  test('cannot report a click through ping', () => {
    const a = dom(`<a href="https://example.com/" ping="${REMOTE}/ping">x</a>`).querySelector('a')
    expect(a?.hasAttribute('ping')).toBe(false)
  })

  test('mail and phone links are kept', () => {
    const doc = dom('<a href="mailto:alice@example.com">m</a><a href="tel:+15550100">t</a>')
    expect([...doc.querySelectorAll('a')].map((a) => a.getAttribute('href'))).toEqual([
      'mailto:alice@example.com',
      'tel:+15550100',
    ])
  })

  test('links inside svg get the same treatment', () => {
    const a = dom('<svg><a href="https://example.com/svg"><text>x</text></a></svg>').querySelector('svg a')
    expect(a?.getAttribute('href')).toBe('https://example.com/svg')
    expect(a?.getAttribute('target')).toBe('_blank')
    expect(a?.getAttribute('rel')).toBe('noopener noreferrer nofollow')
  })
})

describe('inline images', () => {
  const cids = new Map([['chart@example.com', 'blob:local/chart']])

  test('a cid reference becomes the local picture', () => {
    const doc = dom(
      '<img id="a" src="cid:chart@example.com"><img id="b" src="CID:<chart@example.com>">',
      true,
      cids,
    )
    expect(doc.querySelector('#a')?.getAttribute('src')).toBe('blob:local/chart')
    expect(doc.querySelector('#b')?.getAttribute('src')).toBe('blob:local/chart')
  })

  test('a cid reference to nothing loses its source instead of being requested', () => {
    const img = dom('<img src="cid:missing@example.com">', true, cids).querySelector('img')
    expect(img?.hasAttribute('src')).toBe(false)
  })
})

describe('tracking pixels', () => {
  test.each([
    ['1x1', `<img src="${REMOTE}/p.gif" width="1" height="1">`],
    ['0x0', `<img src="${REMOTE}/p.gif" width="0" height="0">`],
    ['one tiny side', `<img src="${REMOTE}/p.gif" width="1" height="40">`],
    ['1px', `<img src="${REMOTE}/p.gif" width="1px" height="1px">`],
    ['hidden by display', `<img src="${REMOTE}/p.gif" style="display:none">`],
    ['hidden by visibility', `<img src="${REMOTE}/p.gif" style="visibility: hidden">`],
    ['zero size in style', `<img src="${REMOTE}/p.gif" style="width:0;height:0">`],
    ['protocol-relative', '<img src="//tracker.example/p.gif" width="1" height="1">'],
    ['a tab inside the scheme', '<img src="ht\ttps://tracker.example/p.gif" width="1" height="1">'],
  ])('an invisible remote image is dropped: %s', (_what, html) => {
    expect(dom(html).querySelectorAll('img')).toHaveLength(0)
  })

  test('a visible remote image is kept', () => {
    const img = dom(`<img src="${REMOTE}/photo.jpg" width="120" height="80">`).querySelector('img')
    expect(img?.getAttribute('src')).toBe(`${REMOTE}/photo.jpg`)
  })

  test('a tiny image carried inside the message is kept: it cannot report anything', () => {
    const cids = new Map([['dot', 'blob:local/dot']])
    const doc = dom(
      '<img src="cid:dot" width="1" height="1"><img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" width="1" height="1">',
      true,
      cids,
    )
    expect(doc.querySelectorAll('img')).toHaveLength(2)
  })
})

describe('with remote content switched off', () => {
  const cids = new Map([['chart', 'blob:local/chart']])
  const blocked = (html: string) => dom(html, false, cids)

  /**
   * Everything in the result that a browser would fetch without being asked.
   * Written apart from the sanitiser's own list of attributes on purpose.
   */
  function fetches(doc: Document): string[] {
    const found: string[] = []
    const remote = (v: string) => /^(?:https?:)?\/\//i.test(v.replace(/[\t\n\r]/g, '').trim())
    for (const el of doc.querySelectorAll('*')) {
      const link = el.localName === 'a' || el.localName === 'area'
      for (const attr of el.attributes) {
        const name = attr.name.toLowerCase()
        if (link && (name === 'href' || name === 'xlink:href')) continue
        if (name === 'srcset') {
          for (const candidate of attr.value.split(',')) {
            if (remote(candidate.trim().split(/\s+/)[0] ?? '')) found.push(`${el.localName} srcset`)
          }
        } else if (name === 'style') {
          if (/url\(|image-set\(|@import/i.test(attr.value)) found.push(`${el.localName} style`)
        } else if (remote(attr.value)) {
          found.push(`${el.localName} ${name}`)
        }
      }
    }
    for (const style of doc.querySelectorAll('style')) {
      if (/url\(|@import|image-set\(/i.test(style.textContent ?? '')) found.push('style element')
    }
    return found
  }

  test.each([
    ['an image', `<img src="${REMOTE}/a.png" width="100">`],
    ['a protocol-relative image', '<img src="//tracker.example/a.png">'],
    ['an image with a tab in its scheme', '<img src="ht\ttps://tracker.example/a.png">'],
    ['an image with upper-case scheme', '<img src="HTTPS://tracker.example/a.png">'],
    ['a second srcset candidate', `<img src="cid:chart" srcset="cid:chart 1x, ${REMOTE}/2x.png 2x">`],
    ['a picture source', `<picture><source srcset="${REMOTE}/s.png"><img src="cid:chart"></picture>`],
    ['a stylesheet link', `<link rel="stylesheet" href="${REMOTE}/s.css">`],
    ['a style element background', `<style>body { background: url(${REMOTE}/bg.png) }</style><p>x</p>`],
    ['a style element import', `<style>@import "${REMOTE}/s.css";</style><p>x</p>`],
    ['a style element font', `<style>@font-face { font-family: x; src: url(${REMOTE}/f.woff) }</style>`],
    ['an inline background', `<div style="background: url('${REMOTE}/bg.png')">x</div>`],
    ['an inline background with a CSS escape', `<div style="background: url(\\68ttps://tracker.example/bg.png)">x</div>`],
    ['an inline image-set', `<div style="background-image: image-set('${REMOTE}/a.png' 1x)">x</div>`],
    ['a background attribute', `<table background="${REMOTE}/t.png"><tr><td background="//tracker.example/c.png">x</td></tr></table>`],
    ['a video and its poster', `<video src="${REMOTE}/v.mp4" poster="${REMOTE}/p.png"></video>`],
    ['an audio clip', `<audio src="${REMOTE}/a.mp3"></audio>`],
    ['a media source', `<video><source src="${REMOTE}/v.mp4"><track src="${REMOTE}/t.vtt"></video>`],
    ['an image input', `<input type="image" src="${REMOTE}/i.png">`],
    ['an svg image', `<svg><image href="${REMOTE}/i.png"></image></svg>`],
    ['an svg image by xlink', `<svg><image xlink:href="${REMOTE}/i.png"></image></svg>`],
    ['an svg use', `<svg><use href="${REMOTE}/i.svg#a"></use></svg>`],
    ['an svg style', `<svg><style>rect { fill: url(${REMOTE}/f.svg#a) }</style></svg>`],
    ['a math style', `<math><mtext><style>* { background: url(${REMOTE}/m.png) }</style></mtext></math>`],
  ])('nothing is fetched for %s', (_what, html) => {
    expect(fetches(blocked(html))).toEqual([])
  })

  test('the checker above does notice remote content when it is allowed', () => {
    // Guards the guard: if `fetches` saw nothing here, the tests above would
    // pass whatever the sanitiser did.
    const doc = dom(
      `<style>p { background: url(${REMOTE}/a.png) }</style><img src="${REMOTE}/a.png" srcset="${REMOTE}/b.png 2x">` +
        `<div style="background: url(${REMOTE}/c.png)">x</div><svg><image href="${REMOTE}/d.png"></image></svg>`,
      true,
    )
    expect(fetches(doc).sort()).toEqual(['div style', 'image href', 'img src', 'img srcset', 'style element'])
  })

  test('a blocked image is marked, so the reader can be told something is missing', () => {
    const img = blocked(`<img src="${REMOTE}/a.png" alt="chart">`).querySelector('img')
    expect(img?.hasAttribute('src')).toBe(false)
    expect(img?.getAttribute('data-pstv-blocked')).toBe('1')
    expect(img?.getAttribute('alt')).toBe('chart')
  })

  test('pictures carried inside the message still show', () => {
    const doc = blocked('<img id="cid" src="cid:chart"><img id="data" src="data:image/png;base64,AAAA">')
    expect(doc.querySelector('#cid')?.getAttribute('src')).toBe('blob:local/chart')
    expect(doc.querySelector('#data')?.getAttribute('src')).toBe('data:image/png;base64,AAAA')
  })

  test('links still work: following one is the reader\'s choice', () => {
    const doc = blocked(
      '<a id="a" href="https://example.com/page">x</a>' +
        '<map name="m"><area id="b" href="https://example.com/area" shape="rect" coords="0,0,1,1"></map>' +
        '<svg><a id="c" href="https://example.com/svg"><text>x</text></a></svg>',
    )
    expect(doc.querySelector('#a')?.getAttribute('href')).toBe('https://example.com/page')
    expect(doc.querySelector('#a')?.getAttribute('target')).toBe('_blank')
    expect(doc.querySelector('#b')?.getAttribute('href')).toBe('https://example.com/area')
    expect(doc.querySelector('#c')?.getAttribute('href')).toBe('https://example.com/svg')
  })

  test('inline styles without a fetch are kept', () => {
    const div = blocked('<div style="color: red; font-weight: bold">x</div>').querySelector('div')
    expect(div?.getAttribute('style')).toBe('color: red; font-weight: bold')
  })

  test('the page is given a policy that forbids reaching another server', () => {
    const withHead = sanitize('<html><head><title>t</title></head><body>x</body></html>', false)
    const doc = new DOMParser().parseFromString(withHead, 'text/html')
    const meta = doc.head.firstElementChild
    expect(meta?.getAttribute('http-equiv')).toBe('Content-Security-Policy')
    expect(meta?.getAttribute('content')).toBe(
      "default-src 'none'; img-src data: blob:; style-src 'unsafe-inline'; font-src data:",
    )
    // And when remote content is allowed, no policy is added.
    expect(sanitize('<p>x</p>', true)).not.toContain('Content-Security-Policy')
  })

  test('a message cannot bring a policy of its own', () => {
    const doc = blocked(
      '<html><head><meta http-equiv="Content-Security-Policy" content="default-src *"></head><body>x</body></html>',
    )
    const policies = [...doc.querySelectorAll('meta[http-equiv="Content-Security-Policy" i]')]
    expect(policies.map((m) => m.getAttribute('content'))).toEqual([
      "default-src 'none'; img-src data: blob:; style-src 'unsafe-inline'; font-src data:",
    ])
  })
})

describe('one message does not affect the next', () => {
  test('blocking for one message does not block the following one', () => {
    const html = `<img src="${REMOTE}/a.png" width="100"><style>p { color: red }</style>`
    sanitize(html, false)
    const doc = dom(html, true)
    expect(doc.querySelector('img')?.getAttribute('src')).toBe(`${REMOTE}/a.png`)
    expect(doc.querySelector('style')).not.toBeNull()
  })

  test('allowing for one message does not allow the following one', () => {
    const html = `<img src="${REMOTE}/a.png" width="100">`
    sanitize(html, true)
    expect(dom(html, false).querySelector('img')?.hasAttribute('src')).toBe(false)
  })

  test('inline pictures of one message are not offered to the next', () => {
    sanitize('<img src="cid:a">', true, new Map([['a', 'blob:local/first']]))
    const img = dom('<img src="cid:a">', true, new Map()).querySelector('img')
    expect(img?.hasAttribute('src')).toBe(false)
  })
})
