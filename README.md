# PST Viewer

A fast, private, **fully in-browser** viewer for Outlook **`.pst` / `.ost`** mailboxes (and `.zip` archives containing them). Everything runs locally on your device: no server, no Python, no build tools to install for end users, and **nothing is ever uploaded**.

Installable as an offline app (PWA): load the site once and it keeps working with no internet.

## Use it now

**Live app: https://bod09.github.io/pst-viewer/**

No setup needed. Open the link, drop in a `.pst`, `.ost`, or `.zip`, and start reading. Nothing is uploaded; everything runs in your browser (see [Privacy](#privacy)). If you would rather run or host it yourself, see [Run it](#run-it) and [Deploy](#deploy).

## Screenshots

| | |
| --- | --- |
| ![Read email 1:1 with attachments](screenshots/mailbox.png) | ![Search across all mailboxes](screenshots/search.png) |
| ![Preview attachments inline](screenshots/preview.png) | ![Open any mailbox](screenshots/landing.png) |

*(Sample data shown is fictional.)*

## Features

- **Open** `.pst`, `.ost`, and `.zip` files (zips are scanned automatically for mailboxes, including nested ones), by drag-and-drop or browse.
- **Multiple mailboxes** at once, with smart auto-labels and inline rename.
- **1:1 email viewing**: full HTML rendering (and RTF-encapsulated HTML) with inline images, in a sandboxed frame. Remote images load like a normal mail client, with invisible tracking pixels (1x1 / hidden images) stripped. **Click any image to view it full screen** and zoom to actual size.
- **Attachment previews**: images, PDF, text/code, audio, video, nested emails, **spreadsheets** (`.xlsx/.xls/.csv/.ods`), and **Word** (`.docx`). Anything else is one-click downloadable.
- **Fast search** across all mailboxes: subjects, senders, recipients, body text, attachment names, and text inside images. Words are typo-tolerant (fuzzy); numbers and reference codes are matched **exactly**, so an ID search stays precise. Matches are highlighted in the open email (the text, and the matching picture) and it scrolls to the first hit.
- **OCR** (automatic): text inside images is read in the background and made searchable, covering both image attachments and pictures embedded in the email body. Images are sharpened first to read small text more reliably. Engine and model are bundled for full offline use.
- **Export to PDF**: a single email, or merge several into one PDF (oldest-first or newest-first).
- **Offline PWA**: works with no connection after first load, and is installable.

## Run it

Requires [Node.js](https://nodejs.org) (only for the dev/build step; the shipped app is plain static files).

```bash
npm install        # first time only
npm run dev        # development at http://localhost:5173
```

To build the production app and preview it (this is the real offline/installable version):

```bash
npm run build      # outputs static files to dist/
npm run preview    # serve the build at http://localhost:4173
```

## Deploy

The build is a static site, so you can host the contents of `dist/` on any static host (Netlify, Vercel, GitHub Pages, Cloudflare Pages, or any web server). No backend required. Once a visitor loads it, the service worker caches it for offline use. See [DEPLOY.md](DEPLOY.md) for a ready-made Caddy setup (`npm run deploy` assembles a drop-in `deploy/` folder).

## Privacy

There is no server. When you open a file, the browser reads it **directly from your disk** (in small slices, so even multi-gigabyte mailboxes work) and all parsing, rendering, search, OCR, and PDF export happen on your device. Your mailbox is never uploaded. Like a normal mail client, an email that references **remote images** will fetch those from the sender's servers when you view it (invisible tracking pixels are stripped, but a visible remote image can still tell the sender you opened it). Each remote image is fetched only once and then cached locally in your browser, so re-viewing it does not ping the sender again. Apart from that, the only network use is loading the app itself.

## Tech

React + Vite + TypeScript + Tailwind. PST parsing via [`@hiraokahypertools/pst-extractor`](https://www.npmjs.com/package/@hiraokahypertools/pst-extractor) in a Web Worker. Search via MiniSearch, PDF rendering via pdf.js, spreadsheets via SheetJS, Word via docx-preview, OCR via Tesseract.js, zip handling via fflate, HTML sanitizing via DOMPurify. PWA via vite-plugin-pwa (Workbox).

## Known limitations

- **Password-protected / encrypted** PSTs are not supported.
- **PowerPoint (`.pptx`/`.ppt`)** and **OpenDocument text (`.odt`)** attachments are download-only (no reliable in-browser renderer).
- Corrupt mailboxes show a clear per-source error; other loaded mailboxes keep working.
- Search becomes available for a mailbox once its background indexing finishes (a progress indicator is shown).
- **OCR runs in the background after a mailbox opens**, so text inside images becomes searchable a little after everything else. A "Reading images" indicator shows the progress, and search results note when it is still running. It is sharpened for accuracy, but very small or low-contrast text can still be misread. Results are cached on your device so re-opening a mailbox loads faster (the images do not need re-reading); each use keeps the cache fresh, and it clears itself 7 days after a mailbox was last opened.
- **Privacy browsers with canvas fingerprinting protection** (some hardened Chromium forks) scramble canvas pixel data, which breaks the image sharpening OCR relies on, so text inside images may not be searchable there. Body and text search still work everywhere. For image OCR, use a standard Chromium, or allow canvas/fingerprinting for the site.
