# AGENTS.md

Instructions for AI coding agents working in this repository. Read
[CONTRIBUTING.md](CONTRIBUTING.md) as well; this file adds to it and does not
repeat it.

PST Viewer is an in-browser viewer for Outlook `.pst`/`.ost` mailboxes and
`.msg`, `.eml` and `.zip` files. Vite, React, TypeScript and Tailwind; parsing,
search and OCR run in a Web Worker (`src/worker/pst.worker.ts`).

## Commands

```bash
npm install          # applies patches/ via patch-package
npm run dev          # development server
npm run check        # type-check, lint, tests, production build
npm run test:e2e     # the built app in Chromium (once: npx playwright install chromium)
npm test             # tests only; npm test -- tests/unit/mime.test.ts for one file
npm run typecheck    # types only
npm run lint         # oxlint
npm run mailboxes    # download the public .pst/.ost/.msg test files (once, 47 MB)
npm run baselines    # re-record tests/baselines/ after an intended change in what is read
npm run fidelity -- <mailbox> [--update]   # the same check on a private mailbox
```

Tests are in `tests/` and described in [tests/README.md](tests/README.md).
Without `npm run mailboxes`, the tests on real files are skipped locally; CI
runs them, so run them yourself before saying a worker change is tested.

## Rules

1. **Nothing leaves the device.** No new network requests, analytics,
   telemetry, or scripts loaded from a CDN. The app must keep working offline.
2. **Never commit mail.** No `.pst`, `.ost`, `.msg` or `.eml` files and nothing
   from `.fidelity/` or `fixtures/`. Do not copy real message content into
   code, comments, tests, commit messages or pull request text, and that
   includes the public test files: tests compare what the worker says in one
   place with what it says in another instead of quoting it. Made-up mail
   (`tests/support/fixtures.mjs`) uses example.com addresses.
3. **Treat everything in a mail file as hostile**: headers, display names,
   encoded words, filenames, MIME parameters, HTML and attachment contents.
4. **Sanitise any HTML that came from mail or an attachment.** Email bodies go
   through `sanitizeEmailHtml` (`src/lib/sanitizeHtml.ts`) and are shown only
   in the sandboxed frame in `src/components/EmailFrame.tsx`. Anything else
   rendered as HTML goes through DOMPurify with a narrow allow-list, as the
   spreadsheet preview does in `AttachmentPreview.tsx`.
5. **Mind memory on large mailboxes.** Read messages one at a time with
   `folderSequence()`, never `folder.getEmails()` in a loop over a mailbox.
   Skip and count unreadable messages instead of failing. Do not keep parsed
   messages once their data has been extracted.
6. **Do not hand-edit `node_modules/`** without regenerating the patch in
   `patches/` (see CONTRIBUTING.md).
7. **Prefer existing dependencies.** Add a new one only when it is clearly
   needed, and say why in the pull request.

## Before calling a change done

- `npm run check` passes, with the public test files downloaded
  (`npm run mailboxes`), so that nothing was skipped.
- `npm run test:e2e` passes.
- A bug fix has a test that fails without the fix. New behaviour has tests.
  Put them where the tests for that code already are.
- Never make a failing test pass by weakening it, skipping it, or re-recording
  a baseline you cannot explain. If a test is wrong, say why in the pull
  request.
- If `tests/baselines/` changed: every difference is one the change was meant
  to make, and the pull request says so.
- If anything under `src/worker/` changed: also run the fidelity check on at
  least one real `.pst` or `.ost` of your own, recording the baseline on `main`
  first. Report the result, including anything that did not match.
- If the change is visible in the UI: run it and look, then include a
  screenshot in the pull request, or a short recording when the change is
  about movement or a sequence of steps.

Say which of these you ran. If something could not be checked, say that
plainly rather than describing the change as verified.

## Pull requests

State that the change was made with AI assistance and name the tool.
