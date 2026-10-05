// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { renderHook } from '../support/hook'

// The module keeps the current branding in a variable, so each test loads a
// fresh copy.
async function loadBranding() {
  vi.resetModules()
  return import('../../src/lib/branding')
}

/** Make branding.json answer with `body` (an object is sent as JSON). */
function serve(body: unknown, ok = true) {
  const fetchMock = vi.fn(async () => ({
    ok,
    json: async () => {
      if (typeof body === 'string') return JSON.parse(body)
      return body
    },
  }))
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

const css = (name: string) => document.documentElement.style.getPropertyValue(name)

beforeEach(() => {
  localStorage.clear()
  document.documentElement.removeAttribute('style')
  document.title = 'before'
})
afterEach(() => vi.unstubAllGlobals())

describe('initBranding', () => {
  test('asks for branding.json beside the app, without the browser cache', async () => {
    const fetchMock = serve({})
    const { initBranding } = await loadBranding()
    await initBranding()
    expect(fetchMock).toHaveBeenCalledWith('/branding.json', { cache: 'no-cache' })
  })

  test('applies what the file says', async () => {
    serve({ name: ' Acme Mail ', tagline: 'Internal use', logo: '/logo.svg', logoSize: 36, accent: '#ff6600', theme: '#102030' })
    const branding = await loadBranding()
    await branding.initBranding()
    expect(renderHook(branding.useBranding)).toEqual({
      name: 'Acme Mail',
      tagline: 'Internal use',
      logo: '/logo.svg',
      logoSize: 36,
      accent: '#ff6600',
      theme: '#102030',
    })
    expect(document.title).toBe('Acme Mail')
    expect(css('--color-sky-500')).toBe('#ff6600')
    expect(css('--color-sky-300')).toBe('color-mix(in oklab, #ff6600 64%, white)')
    expect(css('--color-slate-900')).toMatch(/^oklch\(/)
  })

  test.each([
    ['missing', undefined, 28],
    ['zero, meaning "default"', 0, 28],
    ['negative', -10, 28],
    ['not a number', 'big', 28],
    ['a number with a unit', '40px', 28],
    ['a number in a string', '36', 36],
    ['a fraction', 30.6, 31],
    ['too small', 4, 16],
    ['too large', 400, 44],
    ['infinite', '1e999', 28],
  ])('logo size %s', async (_what, logoSize, expected) => {
    serve({ logoSize })
    const branding = await loadBranding()
    await branding.initBranding()
    // Read through the same store the header component uses.
    expect(renderHook(branding.useBranding).logoSize).toBe(expected)
  })

  test.each([
    ['the file is missing', () => serve({}, false)],
    ['the file is not JSON', () => serve('{ not json')],
    ['the file is JSON but not an object', () => serve('"just a string"')],
    ['the file is null', () => serve('null')],
    ['the network fails', () => vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new TypeError('offline'))))],
  ])('keeps the defaults when %s', async (_what, arrange) => {
    arrange()
    const branding = await loadBranding()
    await expect(branding.initBranding()).resolves.toBeUndefined()
    expect(renderHook(branding.useBranding)).toEqual(branding.DEFAULT_BRANDING)
    expect(document.title).toBe('before')
  })

  test('values of the wrong type are ignored one by one, not all together', async () => {
    serve({ name: 42, tagline: ['x'], logo: { src: 'x' }, accent: null, theme: '#203040', logoSize: 30 })
    const branding = await loadBranding()
    await branding.initBranding()
    expect(renderHook(branding.useBranding)).toEqual({
      ...branding.DEFAULT_BRANDING,
      theme: '#203040',
      logoSize: 30,
    })
  })
})

describe('the reader\'s own colours', () => {
  test('win over the deployment\'s, and survive a branding file that never loads', async () => {
    localStorage.setItem('pstviewer.accent', '#00aa55')
    serve({}, false)
    const { initBranding, getUserAccent } = await loadBranding()
    await initBranding()
    expect(getUserAccent()).toBe('#00aa55')
    expect(css('--color-sky-500')).toBe('#00aa55')

    serve({ accent: '#ff0000' })
    const again = await loadBranding()
    await again.initBranding()
    expect(css('--color-sky-500')).toBe('#00aa55')
  })

  test('can be set and cleared, falling back to the deployment\'s', async () => {
    serve({ accent: '#ff0000' })
    const { initBranding, setUserAccent, getUserAccent } = await loadBranding()
    await initBranding()
    setUserAccent('#123456')
    expect(css('--color-sky-500')).toBe('#123456')
    expect(localStorage.getItem('pstviewer.accent')).toBe('#123456')
    setUserAccent('')
    expect(getUserAccent()).toBe('')
    expect(localStorage.getItem('pstviewer.accent')).toBeNull()
    expect(css('--color-sky-500')).toBe('#ff0000')
  })

  test('a theme colour repaints every surface step, and clearing it restores the default', async () => {
    serve({})
    const { initBranding, setUserTheme, getUserTheme } = await loadBranding()
    await initBranding()
    expect(css('--color-slate-900')).toBe('')
    setUserTheme('#1e3a5f')
    expect(getUserTheme()).toBe('#1e3a5f')
    const steps = [100, 200, 300, 400, 500, 600, 700, 800, 900, 950]
    for (const step of steps) expect(css(`--color-slate-${step}`)).toMatch(/^oklch\(\d+(\.\d)?% \d\.\d{4} \d+\.\d\)$/)
    setUserTheme('')
    for (const step of steps) expect(css(`--color-slate-${step}`)).toBe('')
  })

  test('a dark pick keeps text light; a pale pick flips to dark text on light panels', async () => {
    serve({})
    const { initBranding, setUserTheme } = await loadBranding()
    await initBranding()
    const lightness = (step: number) => Number(/^oklch\(([\d.]+)%/.exec(css(`--color-slate-${step}`))?.[1])
    setUserTheme('#101828')
    expect(lightness(100)).toBeGreaterThan(lightness(950) + 50) // text far lighter than the background
    setUserTheme('#f1f5f9')
    expect(lightness(950)).toBeGreaterThan(lightness(100) + 50) // and the other way round
  })

  test('a colour that is not #rrggbb still gives a usable theme', async () => {
    serve({})
    const { initBranding, setUserTheme } = await loadBranding()
    await initBranding()
    setUserTheme('rebeccapurple')
    expect(css('--color-slate-900')).toMatch(/^oklch\(/)
    expect(css('--color-slate-900')).not.toContain('NaN')
  })

  test('storage that refuses to work does not break the page', async () => {
    serve({})
    const { initBranding, setUserAccent, getUserAccent, getUserTheme } = await loadBranding()
    const broken = () => {
      throw new DOMException('denied', 'SecurityError')
    }
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(broken)
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(broken)
    await expect(initBranding()).resolves.toBeUndefined()
    expect(() => setUserAccent('#123456')).not.toThrow()
    expect(getUserAccent()).toBe('')
    expect(getUserTheme()).toBe('')
    vi.restoreAllMocks()
  })
})
