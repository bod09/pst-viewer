import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { beforeAll, describe, expect, test } from 'vitest'
import { check, unusable } from '../../scripts/lib/fidelity.mjs'
import { scanZipForPsts } from '../../src/lib/zip'
import type { PstWorkerApi } from '../../src/worker/pst.worker'
import { fixtureFiles } from '../support/fixtures.mjs'
import { fileOf } from '../support/files'
import {
  havePublicMailboxes,
  publicFileNames,
  publicMailbox,
  requirePublicMailboxes,
} from '../support/mailboxes'
import { loadWorker } from '../support/worker'

/**
 * The fidelity check, run over every baseline kept in the repository.
 *
 * Each baseline records what the worker read from one file: every folder,
 * every message in order, and a hash of every body. If a change makes the
 * worker read any of it differently, the test for that file fails and says
 * which folder, which message and which field.
 *
 * If that is what the change was meant to do, re-record them
 * (`npm run baselines`) and explain the differences in the pull request.
 */
const DIR = fileURLToPath(new URL('../baselines/', import.meta.url))
const baselines = readdirSync(DIR)
  .filter((name) => name.endsWith('.json'))
  .map((name) => ({ name: name.slice(0, -'.json'.length), baseline: JSON.parse(readFileSync(DIR + name, 'utf8')) }))

const fixtures = fixtureFiles()
const isFixture = (name: string) => name in fixtures

let api: PstWorkerApi
beforeAll(async () => {
  api = await loadWorker()
})

describe('the baselines themselves', () => {
  test('there is one for every fixture and every public mailbox, and no others', () => {
    expect(baselines.map((b) => b.name).sort()).toEqual([...Object.keys(fixtures), ...publicFileNames].sort())
  })

  test.each(baselines)('$name: can be compared against, and covers every body', ({ name, baseline }) => {
    expect(unusable(baseline)).toBeNull()
    expect(baseline.file).toBe(name)
    expect(baseline.full).toBe(true)
    expect(baseline.bodies).toBe(baseline.messages)
  })

  // Only mail made up for this repository may appear in it as text.
  test.each(baselines.filter((b) => !isFixture(b.name)))('$name: holds no text from the mailbox', ({ baseline }) => {
    expect(baseline.redacted).toBe(true)
    // Every piece of text anywhere in it must be a hash, except the few
    // fields that can only hold an id or one of a fixed set of words. Written
    // this way round so that a field added later is covered without anyone
    // remembering to list it.
    const allowed: Record<string, RegExp> = {
      file: /^.+$/, // the name of the public file itself
      id: /^[\w/.:-]+$/,
      cls: /^[\w. -]*$/, // IPM.Note and the like
      kind: /^(email|contact|appointment|distlist|task|journal|note)$/,
    }
    const hash = /^[0-9a-f]{16}$/
    const unhashed: string[] = []
    const walk = (value: unknown, key: string) => {
      if (typeof value === 'string') {
        if (!(allowed[key] ?? hash).test(value)) unhashed.push(key)
      } else if (Array.isArray(value)) {
        for (const item of value) walk(item, key)
      } else if (value && typeof value === 'object') {
        for (const [k, v] of Object.entries(value)) walk(v, k)
      }
    }
    walk(baseline, '')
    expect(unhashed).toEqual([])
  })
})

describe('made-up mail reads as recorded', () => {
  test.each(baselines.filter((b) => isFixture(b.name)))('$name', async ({ name, baseline }) => {
    const { problems } = await check(api, fileOf(name, fixtures[name]), baseline, scanZipForPsts)
    expect(problems).toEqual([])
  })
})

describe('public test files read as recorded', () => {
  test('the files are here, or this is a machine where they are allowed not to be', () => {
    // On a fresh clone they are skipped, with a note at the start of the run
    // (tests/support/global-setup.ts). In CI their absence is a failure.
    expect(havePublicMailboxes || !requirePublicMailboxes, 'public test files are missing. Run: npm run mailboxes').toBe(true)
  })

  test.skipIf(!havePublicMailboxes).each(baselines.filter((b) => !isFixture(b.name)))(
    '$name',
    async ({ name, baseline }) => {
      // Not revealing the text: this output can end up in a public test log.
      // To see what a difference is about, on your own machine:
      //   npm run fidelity -- "fixtures/public/<file>" --baselines tests/baselines
      const { problems, current } = await check(api, publicMailbox(name), baseline, scanZipForPsts, { reveal: false })
      expect(problems).toEqual([])
      expect(current.messages).toBe(baseline.messages)
    },
  )
})
