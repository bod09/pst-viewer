# AGENTS.md

Instructions for AI coding agents working in this repository. Read
[CONTRIBUTING.md](CONTRIBUTING.md) as well; this file adds to it.

PST Viewer is an in-browser viewer for Outlook `.pst`/`.ost` mailboxes and
`.msg`, `.eml` and `.zip` files. Vite, React, TypeScript and Tailwind; parsing,
search and OCR run in a Web Worker (`src/worker/pst.worker.ts`).

## Commands

```bash
npm install          # applies patches/ via patch-package
npm run dev          # development server
npm run check        # type-check, lint, tests with coverage limits, production build
npm run test:e2e     # the built app in Chromium (once: npx playwright install chromium)
npm test             # tests only; npm test -- tests/unit/mime.test.ts for one file
npm run typecheck    # types only
npm run lint         # oxlint
npm run mailboxes    # download the test mailboxes that are not in samples/ (once, 46 MB)
npm run baselines    # re-record tests/baselines/ (only for an intended change, see below)
npm run fidelity -- <mailbox> [--update] [--full]   # the same check on a private mailbox
```

`npm run check` and `npm run test:e2e` are exactly what CI runs. Tests are in
`tests/` and described in [tests/README.md](tests/README.md).

Most sample mail is in the repository (`samples/`). A few tests read larger
mailboxes that hold real mail and need `npm run mailboxes` first. Without it
those are skipped, unless `CI` or `REQUIRE_MAILBOXES=1` is
set in the environment, in which case they fail instead. Many agent sandboxes
set `CI`; if a fresh clone fails saying the public test files are missing, run
`npm run mailboxes`.

## Rules

1. **Nothing leaves the device.** No new network requests, analytics,
   telemetry, or scripts loaded from a CDN. The app must keep working offline.
2. **Never commit mail.** No `.pst`, `.ost`, `.msg` or `.eml` files and nothing
   from `.fidelity/` or `fixtures/`. The one exception is `samples/`, which
   holds made-up mail and openly licensed synthetic test files; do not add to
   it unless asked (see `samples/README.md`). Do not copy real message content into
   code, comments, tests, commit messages, pull request text, screenshots or
   recordings. The public test files count as real mail: a test on them
   compares what the worker says in one place with what it says in another,
   and never quotes them. Made-up mail (`tests/support/fixtures.mjs`) uses
   example.com and `.example` addresses.
3. **Treat everything in a mail file as hostile**: headers, display names,
   encoded words, filenames, MIME parameters, HTML and attachment contents.
4. **Sanitise any HTML that came from mail or an attachment.** Email bodies go
   through `sanitizeEmailHtml` (`src/lib/sanitizeHtml.ts`) and are shown only
   in the sandboxed frame in `src/components/EmailFrame.tsx`. Anything else
   rendered as HTML goes through DOMPurify with a narrow allow-list, as the
   spreadsheet preview does in `AttachmentPreview.tsx`.
5. **Mind memory on large mailboxes.** Read messages one at a time with
   `folderSequence()`, never with `folder.getEmails()`.
   Skip and count unreadable messages instead of failing. Do not keep parsed
   messages once their data has been extracted.
6. **Do not hand-edit `node_modules/`** without regenerating the patch in
   `patches/` (see CONTRIBUTING.md).
7. **Prefer existing dependencies.** Add a new one only when it is clearly
   needed, and say why in the pull request.

## Before calling a change done

- `REQUIRE_MAILBOXES=1 npm run check` passes. With that set, missing public
  test files are a failure instead of a skip (run `npm run mailboxes` first).
- `REQUIRE_MAILBOXES=1 npm run test:e2e` passes.
- A bug fix has a test that fails without the fix. New behaviour has tests.
  Put them where the tests for that code already are.
- A new file that parses or writes mail, attachments or exported files gets a
  coverage limit of its own in `vitest.config.ts`, next to the ones already
  there, so that later changes to it cannot go untested.
- If the change is visible in the UI: start the app (`npm run dev`), open the
  made-up files from `npm run fixtures`, and look. Include a screenshot in the
  pull request, or a short recording when the change is about movement or a
  sequence of steps. Screenshots and recordings show made-up mail only, never
  a real mailbox and never the public test files.

Say which of these you ran. If something could not be checked, say that
plainly rather than describing the change as verified.

### Never make a failing check pass by weakening it

That means: no skipped, deleted or loosened tests; no lint rule switched off
and no disable comment added to get past one; no coverage limit lowered in
`vitest.config.ts`; no hash or size changed in `tests/public-mailboxes.json`;
no edit to `.github/workflows/` to stop something running.

Run `npm run baselines` only when the task is to change what is read from a
mailbox. If a baseline test fails and that was not the task, the code is
wrong: fix the code. When re-recording is right, `git diff --stat
tests/baselines/` must list only the files the change was meant to affect,
and the pull request must say why each one changed.

If you believe a test itself is wrong, change it in a commit of its own and
say in the pull request what was wrong with it.

### Changes under `src/worker/`

The test files are small, so a worker change should also be checked against a
large real mailbox. Ask the person you are working for which private mailbox
to use. Do not go looking for one on disk, and do not use the files in
`fixtures/public/` for this (`npm test` already covers them).

```bash
git stash            # or commit your work first
git switch main
npm run fidelity -- <mailbox> --update     # record how main reads it
git switch -                               # back to your branch (then: git stash pop)
npm run fidelity -- <mailbox>              # compare
```

Report whether it matched and, if not, how many differences and in which
fields. The output names real folders, subjects and people: do not copy those
lines into a pull request, a commit message or an issue. The same goes for a
failing `npm run fidelity` on the public test files. If no mailbox is
available, say that this check was not run.

## Pull requests

State that the change was made with AI assistance and name the tool.

**Never link to the session.** No link to a chat, a coding session or a
transcript, in a commit message, a pull request, an issue or a comment: not
as a trailer (`Claude-Session:` and the like), not in a footer, not anywhere.
The session holds the whole conversation behind the change, and this
repository is public. Tools add these links by themselves, so check the
commit message and the pull request text before you push, and remove any
`Co-Authored-By` line for the tool as well. CI fails if one gets through.
