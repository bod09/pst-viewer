# PST Viewer

A fast, private, **fully in-browser** viewer for Outlook **`.pst` / `.ost`** mailboxes (and `.zip` archives containing them). Everything runs locally on your device — no server, no Python, no build tools to install for end users, and **nothing is ever uploaded**.

Installable as an offline app (PWA): load the site once and it keeps working with no internet.

## Features

- **Open** `.pst`, `.ost`, and `.zip` files (zips are scanned automatically for mailboxes, including nested ones) — by drag-and-drop or browse.
- **Multiple mailboxes** at once, with smart auto-labels and inline rename.
- **1:1 email viewing** — full HTML rendering (and RTF-encapsulated HTML) with inline images, in a sandboxed frame; remote images blocked by default like a normal mail client.
- **Attachment previews** — images, PDF, text/code, audio, video, nested emails, **spreadsheets** (`.xlsx/.xls/.csv/.ods`), and **Word** (`.docx`). Anything else is one-click downloadable.
- **Fast fuzzy search** across all mailboxes — subjects, senders, recipients, body text, and attachment filenames. Typo-tolerant.
- **OCR** (opt-in) — recognizes text inside image attachments so it becomes searchable. Engine + model are bundled for full offline use.
- **Export to PDF** — a single email, or merge several into one PDF (oldest-first or newest-first).
- **Offline PWA** — works with no connection after first load; installable.

## Run it

Requires [Node.js](https://nodejs.org) (only for the dev/build step — the shipped app is plain static files).

```bash
npm install        # first time only
npm run dev        # development → http://localhost:5173
```

To build the production app and preview it (this is the real offline/installable version):

```bash
npm run build      # outputs static files to dist/
npm run preview    # serve the build → http://localhost:4173
```

## Deploy

The build is a static site — just host the contents of `dist/` on any static host (Netlify, Vercel, GitHub Pages, Cloudflare Pages, or any web server). No backend required. Once a visitor loads it, the service worker caches it for offline use.

## Privacy

There is no server. When you open a file, the browser reads it **directly from your disk** (in small slices, so even multi-gigabyte mailboxes work) and all parsing, rendering, search, OCR, and PDF export happen on your device. Your mail never leaves your machine. The only network use is fetching the app itself on first load (and to pick up updates).

## Tech

React + Vite + TypeScript + Tailwind. PST parsing via [`@hiraokahypertools/pst-extractor`](https://www.npmjs.com/package/@hiraokahypertools/pst-extractor) in a Web Worker. Search via MiniSearch, PDF rendering via pdf.js, spreadsheets via SheetJS, Word via docx-preview, OCR via Tesseract.js, zip handling via fflate, HTML sanitizing via DOMPurify. PWA via vite-plugin-pwa (Workbox).

## Known limitations

- **Password-protected / encrypted** PSTs are not supported.
- **PowerPoint (`.pptx`/`.ppt`)** and **OpenDocument text (`.odt`)** attachments are download-only (no reliable in-browser renderer).
- Corrupt mailboxes show a clear per-source error; other loaded mailboxes keep working.
- Search becomes available for a mailbox once its background indexing finishes (a progress indicator is shown).
- OCR is accurate but slow (a few seconds per image) — that's inherent to on-device OCR.
