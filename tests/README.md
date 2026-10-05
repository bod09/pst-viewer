# Tests

Three layers. The first is the fastest; the last is the closest to what a
person does. A change usually needs a test in only one of them: the lowest
one that can show the behaviour.

| Layer | Where | Runs in | What it is for |
| --- | --- | --- | --- |
| Unit | `tests/unit/` | Node (jsdom where a DOM is needed) | One module at a time: the sanitiser, the `.eml` writer, file names for export, MIME, TNEF (`winmail.dat`), RTF, addresses, telling a file's type from its first bytes, branding |
| Worker | `tests/worker/` | Node | The real worker API, end to end, on made-up mail and on real `.pst`/`.ost`/`.msg` files: opening, listing, search, export, recovery of damaged files, and the fidelity baselines |
| Browser | `tests/e2e/` | Chromium, against a production build | What only a browser can show: that script in a hostile message does not run, what is fetched and what is not, the offline app, export to disk, the user interface |

```bash
npm test                                  # unit and worker tests
npm test -- tests/unit/mime.test.ts       # one file
npm test -- -t "tracking pixel"           # tests whose name matches
npm run test:watch                        # re-run on every save
npm run test:e2e                          # browser tests (builds first)
npm run test:e2e -- --ui                  # the same, in Playwright's test runner window
npm run test:e2e -- hostile               # one file: tests/e2e/hostile.spec.ts
```

Only files named `*.test.ts` under `tests/unit` and `tests/worker`, and
`*.spec.ts` under `tests/e2e`, are run. A test anywhere else would be skipped
without a word, so `tests/unit/layout.test.ts` fails if one appears.

## Test mail

Real mail never goes in the repository, so tests get their mail two ways.

**Made-up messages** are built in [`support/fixtures.mjs`](support/fixtures.mjs):
an ordinary message with an attachment, a forwarded message, one that tries to
spoof its sender, one full of hostile markup, a `.msg`, a zip. Add to it when
you need a new shape of message; use fictional people at example.com. Use
`simpleEml({ ... })` for a quick one-off. A file added to `fixtureFiles()`
needs a baseline: run `npm run baselines` and commit the new file in
`tests/baselines/`.

**Public test files** are real `.pst`, `.ost` and `.msg` files from the test
data of the pst-extractor and msgreader projects. They are listed in
[`public-mailboxes.json`](public-mailboxes.json), each pinned to an exact commit
and a SHA-256. The synthetic ones are kept in the repository, in
[`samples/`](../samples/README.md), so the tests on them always run. Three
larger mailboxes and one message hold real people's mail and are downloaded
instead, by `npm run mailboxes`, into `fixtures/public/` (git-ignored). Until
you run that, the tests that need one of those are skipped: `npm test` names
the missing files at the top of its output, and the browser tests mark theirs
as skipped. In CI, or with `REQUIRE_MAILBOXES=1` set, a missing file is
a failure instead, and CI also fails if any test at all was skipped
(`scripts/check-test-reports.mjs`).

The downloaded files are public, but they are still other people's mail, so
nothing from inside any public file is written into a test. A test on them compares what the worker
says in one place with what it says in another: that every message in the list
opens with the same subject, that a search for a word of a subject finds that
message, that a damaged copy recovers the same messages as the healthy file.
Text is compared as hashes (`sha()` from `scripts/lib/fidelity.mjs`), so a
failing test names the message without printing its subject into a log that
may be public.

## The fidelity baselines

[`baselines/`](baselines) holds, for every piece of test mail, a record of
what the worker read from it: each folder, each message in order, and for each
message hashes of everything the reader shows (both bodies, the people, the
headers, the marks, a contact or appointment card, and every attachment's
name, size, type and bytes).
[`worker/fidelity.test.ts`](worker/fidelity.test.ts) reads every file again
and compares. This is the net under everything else: a change that makes the
worker read a message differently fails here even if no other test thought to
look.

Baselines of made-up mail keep subjects, names and attachment names readable.
In baselines of the public files those, and the folder names, are replaced by
hashes; dates, ids and message types are kept. Either kind fails on any change
and says where.

When a change is meant to alter what is read: run `npm test` first and read
the failures, which name the folder, message and field. Then run
`npm run baselines`, which re-records all of them (it needs
`npm run mailboxes`). `git diff --stat tests/baselines/` should list only the
files you expected. Commit it and explain it in the pull request.

## Writing a test

- **Name it for the behaviour**, in words a reader of the app would use:
  `'an existing file is never written over'`, not `'claimName works'`. The list
  of test names should read as a description of what the app promises.
- **Test through the door callers use.** The export tests drive
  `EmlTreeWriter` against an in-memory folder
  ([`support/memory-fs.ts`](support/memory-fs.ts)); they do not reach into its
  private helpers. That way the tests survive a rewrite of the insides.
- **Check hostile input against an independent rule.** The file name tests do
  not ask the code under test whether a name is safe; they have their own
  checker, written from the platforms' rules, and a test that the checker
  itself objects to bad names. A guard that is never seen to fail proves
  nothing.
- **No conditional assertions.** An `expect` inside an `if` can silently never
  run. Filter the list first, then assert on every item.
- **Dates**: tests run in the Asia/Tokyo timezone on purpose (see
  [`support/global-setup.ts`](support/global-setup.ts)). Build local times with
  `new Date(2024, 2, 12, 10, 15)` and UTC ones with `Date.UTC(...)`.
- **A bug fix starts with a test that fails.** Write it, watch it fail for the
  right reason, then fix the code.

### Worker tests

```ts
import { beforeAll, expect, test } from 'vitest'
import type { PstWorkerApi } from '../../src/worker/pst.worker'
import { fixture } from '../support/files'
import { loadWorker } from '../support/worker'

let api: PstWorkerApi
beforeAll(async () => {
  api = await loadWorker()
  await api.openMsgSource('mine', [fixture('mail.eml')])
  await api.indexSource('mine')
})

test('a word in the body finds the message', async () => {
  expect(await api.search('pomegranate')).toHaveLength(1)
})
```

The worker keeps its open mailboxes and search index in module variables.
Each `.test.ts` file gets its own copy of the worker, so one file's mailboxes
never show up in another's. Within a file, give each mailbox a different id
(the first argument to `openSource` and `openMsgSource`), or close it when
done.

For real files, guard the tests so a fresh clone still passes:

```ts
import { describe, test } from 'vitest'
import { publicMailbox, usable } from '../support/mailboxes'

// A file in samples/ is always there:
test('...', async () => {
  await api.openSource('contacts', publicMailbox('contacts.pst'))
})

// One that has to be downloaded may not be:
describe.skipIf(!usable('enron.pst'))('...', () => {
  test('...', async () => {
    await api.openSource('enron', publicMailbox('enron.pst'))
  })
})
```

### Browser tests

Import `test` and `expect` from [`e2e/support.ts`](e2e/support.ts), not from
Playwright. That `test` answers every request that leaves the app's own origin
locally and records it, so no test can touch the internet, and a test can ask
what was fetched:

```ts
import { expect, fixture, openFiles, openMessage, test } from './support'

test('opening a message fetches nothing', async ({ page, requests }) => {
  await openFiles(page, fixture('mail.eml'))
  await openMessage(page, 'Quarterly zebra report')
  expect(requests.outside).toEqual([])
})
```

The other helpers there: `emailFrame` (the frame an HTML message is shown in),
`setSetting`, `reader`, `messageRow`, `folderRow`, and
`publicMailboxPath('enron.pst')`, which gives the path of a public test file
and skips the test when it has not been downloaded.

Find things the way a person or a screen reader would (`getByRole`,
`getByText`), not by CSS class. If something cannot be found that way, that is
usually worth fixing in the app.

When a browser test fails, `test-results/` has a screenshot and a trace:
`npx playwright show-trace test-results/<test>/trace.zip` replays it step by
step. In CI the same files are attached to the run as `browser-test-report`.

## What is not tested

- **OCR** (reading text out of pictures). It needs the Tesseract engine and
  language model, is slow, and is not exact, so there is no automated test.
- **Printing to PDF.** The tests check the page that is handed to the browser
  to print, not the PDF that comes out.
- **Browsers other than Chromium.** The browser tests run in Chromium only;
  folder export exists only there.
- **Mailboxes of many gigabytes.** Memory use on large files is checked by
  hand (see CONTRIBUTING.md); the test files are at most 16 MB.
