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
  or with the synthetic files from `npm run fixtures`.

## Getting started

You need [Node.js](https://nodejs.org) 22.

```bash
npm install        # also applies the patches in patches/
npm run dev        # http://localhost:5173
```

`npm run build && npm run preview` serves the production build, which is the
offline, installable version, at http://localhost:4173.

## Checking your change

CI runs `npm run build` on every pull request, which type-checks and builds.
Run it locally before pushing.

There is no unit test suite, so `npm test` only prints an error. What there is
instead is a fidelity check, which drives the real parsing worker over a
mailbox and compares every message, in order, against a baseline: id, subject,
sender, recipients, date and a hash of the body.

If your change touches anything under `src/worker/`, record a baseline before
you start and check against it after:

```bash
npm run fixtures                                  # synthetic .eml/.msg/.zip in fixtures/
npm run fidelity -- path/to/mailbox.pst --update  # on main, before your change
npm run fidelity -- path/to/mailbox.pst           # after your change
```

Baselines are written to `.fidelity/`, which is git-ignored, because they record
real subjects and addresses. Use the biggest and oddest mailboxes you have; a
change can look fine on a small file and still go wrong on a large one.

For changes to what is shown on screen, please include a screenshot.

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
  files you tried.
- If an AI tool helped write it, say so in the description.
- Pull requests are squash-merged, so the title becomes the commit message.
