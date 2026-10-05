# Tests

Three layers, from fastest to closest to what a person does. A change usually
needs a test in only one of them: the lowest one that can show the behaviour.

| Layer | Where | Runs in | What it is for |
| --- | --- | --- | --- |
| Unit | `tests/unit/` | Node (jsdom where a DOM is needed) | One module at a time: the sanitiser, the `.eml` writer, file names for export, MIME, TNEF, RTF, addresses, file type sniffing, branding |
| Worker | `tests/worker/` | Node | The real worker API, end to end, on made-up mail and on real `.pst`/`.ost`/`.msg` files: opening, listing, search, export, recovery of damaged files, and the fidelity baselines |
| Browser | `tests/e2e/` | Chromium, against a production build | What only a browser can show: that script in a hostile message does not run, what is fetched and what is not, the offline app, export to disk, the user interface |

```bash
npm test                                  # unit and worker tests
npm test -- tests/unit/mime.test.ts       # one file
npm test -- -t "tracking pixel"           # tests whose name matches
npm run test:watch                        # re-run on every save
npm run test:e2e                          # browser tests (builds first)
npm run test:e2e -- --ui                  # the same, in Playwright's test runner window
npm run test:e2e -- hostile               # one spec
```

## Test mail

Real mail never goes in the repository, so tests get their mail two ways.

**Made-up messages** are built in [`support/fixtures.mjs`](support/fixtures.mjs):
an ordinary message with an attachment, a forwarded message, one that tries to
spoof its sender, one full of hostile markup, a `.msg`, a zip. Add to it when
you need a new shape of message; use fictional people at example.com. Use
`simpleEml({ ... })` for a quick one-off.

**Public test files** are real `.pst`, `.ost` and `.msg` files from the test
data of the pst-extractor and msgreader projects. They are listed in
[`public-mailboxes.json`](public-mailboxes.json), each pinned to an exact commit
and a SHA-256, and downloaded by `npm run mailboxes` into `fixtures/public/`
(git-ignored). Tests that need them are skipped until you run that, and say so
at the top of the run. In CI they are required: a missing file fails the build
rather than quietly skipping tests.

Those files are public, but they are still other people's mail, so nothing from
inside them is written into a test. A test on them compares what the worker
says in one place with what it says in another: that every message in the list
opens with the same subject, that a search for a word of a subject finds that
message, that a damaged copy recovers the same messages as the healthy file.

## The fidelity baselines

[`baselines/`](baselines) holds, for every test file, a record of what the
worker read from it: each folder, each message in order, and a hash of each
body. [`worker/fidelity.test.ts`](worker/fidelity.test.ts) reads every file
again and compares. This is the net under everything else: a change that makes
the worker read any message differently fails here even if no other test
thought to look.

Baselines of made-up mail are plain text. Baselines of the public files are
redacted: every piece of text is replaced by a hash of itself, which still
fails on any change and says where.

When a change is meant to alter what is read, run `npm run baselines`, check
that the diff is what you intended and nothing else, commit it, and explain it
in the pull request.

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
import { loadWorker } from '../support/worker'
import { fixture } from '../support/files'

const api = await loadWorker()
await api.openMsgSource('mine', [fixture('mail.eml')])
await api.indexSource('mine')
expect(await api.search('pomegranate')).toHaveLength(1)
```

The worker keeps its open mailboxes and search index in module variables.
Each test file gets its own copy, so files cannot disturb each other; within a
file, use a different source id for each mailbox or close it when done.

For real files, guard the tests so a fresh clone still passes:

```ts
import { havePublicMailboxes, publicMailbox } from '../support/mailboxes'

describe.skipIf(!havePublicMailboxes)('...', () => {
  test('...', async () => {
    await api.openSource('enron', publicMailbox('enron.pst'))
  })
})
```

### Browser tests

Helpers are in [`e2e/support.ts`](e2e/support.ts): `openFiles`, `openMessage`,
`emailFrame`, `setSetting`, and `watchRequests`, which records every request
that leaves the app's own origin and answers it locally, so a test can assert
on what was fetched and never touches the internet.

Find things the way a person or a screen reader would (`getByRole`,
`getByText`), not by CSS class. If something cannot be found that way, that is
usually worth fixing in the app.

When a browser test fails, `test-results/` has a screenshot and a trace:
`npx playwright show-trace test-results/<test>/trace.zip` replays it step by
step. In CI the same files are attached to the run as `browser-test-report`.

## What is not tested

- **OCR** (reading text out of pictures). It needs the Tesseract engine and
  language model, is slow, and is not exact, so there is no automated test.
- **Printing to PDF** beyond the page that is handed to the browser.
- **Browsers other than Chromium.** The browser tests run in Chromium only;
  folder export exists only there.
- **Mailboxes of many gigabytes.** Memory use on large files is checked by
  hand (see CONTRIBUTING.md); the test files are at most 16 MB.
