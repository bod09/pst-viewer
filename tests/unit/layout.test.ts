import { existsSync, readdirSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'vitest'
import config from '../../vitest.config.ts'

/**
 * Tests that guard the test suite itself against going quiet.
 *
 * A test file in the wrong place or with the wrong ending is type-checked and
 * linted like any other, and simply never runs. Nothing would say so.
 */
const TESTS = fileURLToPath(new URL('..', import.meta.url))
const ROOT = fileURLToPath(new URL('../..', import.meta.url))

/** Every file under a directory, as paths relative to it. */
function files(dir: string, prefix = ''): string[] {
  return readdirSync(dir).flatMap((name) =>
    statSync(`${dir}/${name}`).isDirectory() ? files(`${dir}/${name}`, `${prefix}${name}/`) : [`${prefix}${name}`],
  )
}

describe('the layout of tests/', () => {
  test('has only the directories the test runners know about', () => {
    const dirs = readdirSync(TESTS).filter((name) => statSync(TESTS + name).isDirectory())
    expect(dirs.sort()).toEqual(['baselines', 'e2e', 'support', 'unit', 'worker'])
  })

  test.each(['unit', 'worker'])('every file in tests/%s is a test that Vitest will run', (dir) => {
    const found = files(TESTS + dir)
    expect(found.length).toBeGreaterThan(0)
    expect(found.filter((name) => !name.endsWith('.test.ts'))).toEqual([])
  })

  test('every file in tests/e2e is a spec that Playwright will run, or the shared helpers', () => {
    const found = files(`${TESTS}e2e`)
    expect(found.filter((name) => name.endsWith('.spec.ts')).length).toBeGreaterThan(0)
    expect(found.filter((name) => !name.endsWith('.spec.ts') && name !== 'support.ts')).toEqual([])
  })

  test('every coverage limit is for a file that exists', () => {
    // A limit on a path that no longer exists is silently never checked.
    const limits = Object.keys(config.test?.coverage && 'thresholds' in config.test.coverage ? (config.test.coverage.thresholds ?? {}) : {})
    expect(limits.length).toBeGreaterThan(0)
    expect(limits.filter((path) => !existsSync(ROOT + path))).toEqual([])
  })
})
