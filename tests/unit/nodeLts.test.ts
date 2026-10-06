import { describe, expect, test } from 'vitest'
import { newestLts, pinnedMajor } from '../../scripts/node-lts.mjs'

// Shaped like nodejs/Release's schedule.json: even majors get an `lts` date
// six months after `start`, odd majors never do.
const schedule = {
  v22: { start: '2024-04-24', lts: '2024-10-29', maintenance: '2025-10-21', end: '2027-04-30' },
  v24: { start: '2025-05-06', lts: '2025-10-28', maintenance: '2026-10-20', end: '2028-04-30' },
  v25: { start: '2025-10-15', lts: null, maintenance: '2026-04-01', end: '2026-06-01' },
  v26: { start: '2026-05-05', lts: '2026-10-28', maintenance: '2027-10-20', end: '2029-04-30' },
}

describe('newestLts', () => {
  test('the newest major whose LTS has started', () => {
    expect(newestLts(schedule, '2026-10-07')).toBe(24)
    expect(newestLts(schedule, '2026-10-27')).toBe(24)
  })

  test('a major counts from its LTS day, not its release day', () => {
    expect(newestLts(schedule, '2026-10-28')).toBe(26)
    expect(newestLts(schedule, '2026-05-05')).toBe(24)
  })

  test('an odd major is never LTS, however new', () => {
    expect(newestLts(schedule, '2025-11-01')).toBe(24)
  })

  test('a major past its end of life no longer counts', () => {
    expect(newestLts({ v22: schedule.v22 }, '2027-05-01')).toBeNull()
    expect(newestLts(schedule, '2027-05-01')).toBe(26)
  })

  test('a schedule with no LTS at all gives nothing', () => {
    expect(newestLts({ v25: schedule.v25 }, '2026-01-01')).toBeNull()
    expect(newestLts({}, '2026-01-01')).toBeNull()
  })
})

describe('pinnedMajor', () => {
  test('reads the forms .nvmrc is written in', () => {
    expect(pinnedMajor('24\n')).toBe(24)
    expect(pinnedMajor('v24')).toBe(24)
    expect(pinnedMajor('24.19.1')).toBe(24)
    expect(pinnedMajor('lts/*')).toBeNull()
    expect(pinnedMajor('')).toBeNull()
  })

  test('the repository pins the major its test tools run on', async () => {
    const { readFile } = await import('node:fs/promises')
    const pinned = pinnedMajor(await readFile(new URL('../../.nvmrc', import.meta.url), 'utf8'))
    const engines = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8')).engines.node
    expect(engines).toBe(`>=${pinned}`)
    const dockerfile = await readFile(new URL('../../Dockerfile', import.meta.url), 'utf8')
    expect(dockerfile).toContain(`node:${pinned}-alpine`)
    const types = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8')).devDependencies['@types/node']
    expect(types.startsWith(`^${pinned}.`)).toBe(true)
  })
})
