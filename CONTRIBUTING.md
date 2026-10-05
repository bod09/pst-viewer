# Contributing

Thanks for wanting to help. Bug reports, fixes and features are all welcome.
For anything bigger than a small fix, open an issue first so the approach can
be agreed before you put the time in.

Found a security problem? Please don't open an issue; see
[SECURITY.md](SECURITY.md).

## The two things that can't change

- **Everything stays on the user's device.** No uploads, no analytics, no new
  network requests. The only outbound traffic is loading the app itself and
  remote images in an email being read, which users can switch off in
  Settings.
- **Real mail never goes in the repository.** `.pst`, `.ost`, `.msg` and `.eml`
  files are git-ignored for that reason. Test with your own mailboxes locally,
  or with the made-up files from `npm run fixtures`. The same goes for pull
  request text, screenshots and recordings: show made-up mail only.

## Getting started

You need a current [Node.js](https://nodejs.org) 22 (22.22 or newer, which the
test tools require; building alone works on older versions, see DEPLOY.md).

```bash
npm install        # also applies the patches in patches/
npm run dev        # http://localhost:5173
```

`npm run build && npm run preview` serves the production build, which is the
offline, installable version, at http://localhost:4173.

## Checking your change

```bash
npx playwright install chromium   # once, for the browser tests
npm run mailboxes                 # once, downloads the public test files (47 MB)

npm run check        # type-check, lint, tests, production build
npm run test:e2e     # the built app, driven in a real browser
```

CI runs the same two commands on every pull request, and a pull request can
only be merged once they pass. Run them before pushing; together they take
about a minute.

| Command | What it checks | When it fails |
| --- | --- | --- |
| `npm run typecheck` | Types, in the app and in the tests | The compiler names the file and line |
| `npm run lint` | Mistakes a type-checker does not see ([oxlint](https://oxc.rs/docs/guide/usage/linter); the rules are in `.oxlintrc.json`). Prints nothing when all is well | It prints the file, line and rule. Fix the code rather than switching the rule off |
| `npm test` | The parsing, sanitising, search and export code, called directly ([Vitest](https://vitest.dev)). `npm run test:watch` re-runs as you edit | The failing test says what it expected and what it got |
| `npm run test:coverage` | The same tests, and fails if too little of the code that handles hostile mail or writes exported files is run by them. The limits are in `vitest.config.ts` | Open `coverage/index.html` to see which lines no test reached, and add tests for them |
| `npm run test:e2e` | The production build in Chromium ([Playwright](https://playwright.dev)): opening files, hostile mail, search, export, working offline | `test-results/` has a screenshot and a trace of each failure (see [tests/README.md](tests/README.md)) |

`npm run check` runs the first four (with coverage) and then
`npm run build`.

The browser tests build the app twice and serve it on ports 4174 and 4175;
they fail if either port is in use. On Linux, if Chromium does not start, run
`npx playwright install-deps chromium`.

[tests/README.md](tests/README.md) explains how the tests are laid out and how
to add one. A fix for a bug should come with a test that fails without it.

### Test mail

Tests use two kinds of mail, and neither is anyone's private mail:

- **Made-up messages**, built in `tests/support/fixtures.mjs`. To have them as
  files, for trying things by hand, run `npm run fixtures` (they go to
  `fixtures/`, which is git-ignored).
- **Public test files**: real `.pst`, `.ost` and `.msg` files from the test data
  of the libraries that read them. `npm run mailboxes` downloads them once
  (about 47 MB) into `fixtures/public/`, each pinned to an exact commit and
  checked by hash. Until you do, the tests that need them are skipped (`npm
  test` says so at the top of its output). CI always runs them. They are
  public, but still other people's mail: do not quote them in a test, a pull
  request or a screenshot.

### If your change alters what is read from a mailbox

`npm test` includes a fidelity check: for every piece of test mail there is a
baseline in `tests/baselines/` recording each folder, each message in order,
and hashes of everything the reader shows for it (bodies, people, headers,
attachments, contact and appointment details). If the worker reads any of it
differently, the test says which folder, message and field.

When that is what your change is meant to do:

1. Run `npm test` and read the failures first. They are the only place the
   difference is described: the baselines of the public files hold hashes,
   so their diff shows that something changed but not what.
2. Re-record: `npm run baselines` (it needs the public test files, so run
   `npm run mailboxes` first if you have not).
3. Check that `git diff --stat tests/baselines/` lists only the files you
   expected, and commit them.
4. Say in the pull request why each difference is right, without quoting the
   mail.

If the baselines change and you did not expect them to, the code is wrong,
not the baselines.

To see what a difference in a public file is about, on your own machine:
`npm run fidelity -- fixtures/public/<file> --baselines tests/baselines`.

### Checking against your own mailboxes

The test files are small. A change to anything under `src/worker/` should also
be tried on the biggest and oddest mailboxes you have, since a change can look
fine on a small file and still go wrong on a large one. Record a baseline before
you start and check against it after:

```bash
npm run fidelity -- path/to/mailbox.pst --update  # on main, before your change
npm run fidelity -- path/to/mailbox.pst           # after your change
```

By default one message in ten is opened and compared in full, which keeps it
quick on a mailbox of many gigabytes; add `--full` to `--update` to open every
one. These baselines are written to `.fidelity/`, which is git-ignored, because
they record real subjects and addresses. They stay on your machine, and so
should the output: describe a difference in a pull request without pasting it.

For changes to what is shown on screen, please include a screenshot, or a short
recording if the change is about movement or a sequence of steps, showing
made-up mail (`npm run fixtures`).

## Where things live

| Path | What it does |
| --- | --- |
| `src/worker/pst.worker.ts` | Parsing, search and OCR, all in a Web Worker, called through Comlink (`src/worker/client.ts`) |
| `src/worker/chunkReader.ts` | Reads the file in slabs with a shared, size-capped cache |
| `src/worker/msg.ts`, `eml.ts` | Make standalone `.msg` and `.eml` files look like PST messages |
| `src/worker/salvage.ts` | Recovery for damaged PST/OST files |
| `src/store/store.ts` | App state (zustand) |
| `src/lib/sanitizeHtml.ts` | Email HTML sanitising; rendered only inside the sandboxed frame in `src/components/EmailFrame.tsx` |
| `patches/` | Local fixes to `@hiraokahypertools/pst-extractor`, applied on install |
| `tests/` | Unit tests, worker tests on real files, browser tests ([tests/README.md](tests/README.md)) |

## Working with large mailboxes

People open mailboxes of several gigabytes, often on ordinary laptops, so the
worker is careful about what it keeps in memory:

- Read a folder's messages one at a time with `folderSequence()`, not
  `folder.getEmails()`. The bulk call builds every message at once and the
  parser keeps them; on a large folder that is hundreds of megabytes.
- Skip a message that cannot be read and count it, rather than failing the
  folder or the whole operation. Damaged files are common.
- Don't hold on to parsed messages longer than you need them. A message can be
  read again from the file when it is opened.

## The patched dependency

`@hiraokahypertools/pst-extractor` is patched through
[patch-package](https://github.com/ds300/patch-package). If you need to change
it, edit the file under `node_modules/`, then regenerate the patch:

```bash
npx patch-package @hiraokahypertools/pst-extractor
```

and commit the updated file in `patches/`. Fixes that belong upstream are
better sent there as well.

## Pull requests

- Keep each one to a single change; unrelated fixes are easier to review apart.
- Say what it changes, why, and how you tested it, including which mailboxes or
  files you tried. New behaviour and bug fixes come with tests.
- If an AI tool helped write it, say so in the description and name the tool.
- Pull requests are squash-merged, so the title becomes the commit message.
