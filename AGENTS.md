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
npm run build        # type-check and production build (what CI runs)
npm run typecheck    # type-check only
npm run fixtures     # synthetic test mail into fixtures/
npm run fidelity -- <mailbox> [--update]   # compare the worker's reading to a baseline
```

There is no unit test suite, so `npm test` only prints an error. Do not add
a test framework unasked.

## Rules

1. **Nothing leaves the device.** No new network requests, analytics,
   telemetry, or scripts loaded from a CDN. The app must keep working offline.
2. **Never commit mail.** No `.pst`, `.ost`, `.msg` or `.eml` files and nothing
   from `.fidelity/`. Do not copy real message content into code, comments,
   fixtures, commit messages or pull request text. Use example.com addresses.
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

- `npm run build` passes.
- If anything under `src/worker/` changed: record a fidelity baseline on `main`
  with `--update`, then check the change against it, on the files from
  `npm run fixtures` and on at least one real `.pst` or `.ost`. Report the
  result, including anything that did not match.
- If the change is visible in the UI: run it and look, then include a
  screenshot in the pull request.

Say which of these you ran. If something could not be checked, say that
plainly rather than describing the change as verified.

## Pull requests

State that the change was made with AI assistance and name the tool.
