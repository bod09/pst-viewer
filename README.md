# PST Viewer

A fast, private, **fully in-browser** viewer for Outlook **`.pst` / `.ost`** mailboxes and standalone **`.msg` / `.eml`** messages (and `.zip` archives containing them). Everything runs locally on your device: no server, no Python, no build tools to install for end users, and **nothing is ever uploaded**.

Installable as an offline app (PWA): load the site once and it keeps working with no internet.

## Use it now

**Live app: https://bod09.github.io/pst-viewer/**

No setup needed. Open the link, drop in a `.pst`, `.ost`, `.msg`, `.eml`, or `.zip`, and start reading. Nothing is uploaded; everything runs in your browser (see [Privacy](#privacy)). If you would rather run or host it yourself, see [Run it](#run-it) and [Deploy](#deploy).

## Screenshots

| | |
| --- | --- |
| ![Read email with attachments](screenshots/mailbox.png) | ![Search every mailbox at once](screenshots/search.png) |
| ![Preview attachments like PDFs inline](screenshots/preview.png) | ![Drop in a mailbox or message file to open it](screenshots/landing.png) |
| ![Every Outlook folder type, from mail to notes](screenshots/folders.png) | |

*(Sample data shown is fictional.)*

## Features

- **Open** `.pst`, `.ost`, `.msg`, `.eml`, and `.zip` files (zips are scanned automatically for mailboxes and messages, including nested ones), by drag-and-drop or browse. Damaged files are recovered automatically where possible (see Known limitations). Standalone `.msg`/`.eml` files dropped together are grouped into one mailbox, sorted into Outlook-like folders by type (Messages, Contacts, Calendar, Tasks, Notes), and `.msg`/`.eml` files attached to an email open inline like any other message. Password-protected mailboxes open too: an Outlook PST password gates Outlook's own UI, not the data, so none is needed to read the mailbox here.
- **Multiple mailboxes** at once, with smart auto-labels and inline rename.
- **1:1 email viewing**: full HTML rendering (and RTF-encapsulated HTML) with inline images, in a sandboxed frame. Remote images load like a normal mail client, with invisible tracking pixels (1x1 / hidden images) stripped. **Click any image to view it full screen**, then zoom to actual size and drag to pan. A **Headers** button shows the message's full original transport headers. Colour categories, follow-up flags, importance, and sensitivity show as chips, and `winmail.dat` (TNEF) and S/MIME signed messages are unpacked to reveal their real body and attachments.
- **Attachment previews**: images, PDF, text/code, audio, video, nested emails, **spreadsheets** (`.xlsx/.xls/.csv/.ods`), and **Word** (`.docx`). Anything else is one-click downloadable.
- **Every Outlook item type**: contacts (name, emails, phones, company, addresses, birthday, notes), distribution lists (with members), calendar appointments (time, location, organizer, attendees), tasks (status, due date, % complete), journal entries, and sticky notes all render as cards, so nothing shows up blank. **Click any sender or recipient** on an email to look them up in the loaded mailboxes' contacts (matched by exact email address, or exact name when the message has no real address).
- **Fast search** across all mailboxes: subjects, senders, recipients, body text, attachment names, and text inside images. The finished search index is kept on your device (like the OCR cache, cleared 7 days after a mailbox was last opened), so reopening the same file is searchable straight away instead of being scanned again. Words are typo-tolerant (fuzzy); numbers and reference codes are matched **exactly**, so an ID search stays precise. Matches are highlighted in the open email (the text, and the matching picture) and it scrolls to the first hit.
- **OCR** (automatic, can be turned off): text inside images is read in the background and made searchable, covering both image attachments and pictures embedded in the email body. A toggle on the import screen (and in the sidebar) disables it entirely, including its cache; the choice is remembered. Images are sharpened first to read small text more reliably, and results are cached on your device for faster re-opens (cleared 7 days after a mailbox was last opened). Engine and model are bundled for full offline use.
- **Export**: save a single email as **PDF** or as its original **`.eml`** (preserving the real headers and attachments), or merge several emails into one PDF (oldest-first or newest-first).
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

The build is a static site, so you can host the contents of `dist/` on any static host (Netlify, Vercel, GitHub Pages, Cloudflare Pages, or any web server). No backend required. Once a visitor loads it, the service worker caches it for offline use.

A prebuilt **Docker image** is published automatically to `ghcr.io/bod09/pst-viewer`: one `docker compose up`, no Node or build step, hardened by default (non-root, read-only, CSP).

See [DEPLOY.md](DEPLOY.md) for all options: GitHub Pages, Docker, Caddy (`npm run deploy` assembles a drop-in `deploy/` folder), Nginx, Netlify/Vercel/Cloudflare, and object storage.

## Branding

A deployment can be rebranded (name, tagline, logo, accent colour) with no
rebuild.

**Docker** - set environment variables. The logo is a URL: mount an image
file next to the app, point at a hosted one, or use a `data:` URI.

```yaml
    environment:
      BRAND_NAME: "Acme Mail Archive"
      BRAND_TAGLINE: "Internal use only"
      BRAND_ACCENT: "#7c3aed"
      BRAND_LOGO: "/logo.svg"
    volumes:
      - ./logo.svg:/usr/share/nginx/html/logo.svg:ro
```

**Any static host** - overwrite `branding.json` in the deployed folder (in
Docker this also works, mounted over `/usr/share/nginx/html/branding.json`;
environment variables take precedence):

```json
{
  "name": "Acme Mail Archive",
  "tagline": "Internal use only",
  "logo": "logo.svg",
  "accent": "#7c3aed"
}
```

- `name` - shown in the header and the browser tab
- `tagline` - the short line under the name
- `logo` - image URL for the header logo; empty keeps the default icon
- `accent` - any CSS colour; the UI's accent shades are derived from it

The installable app (PWA) is renamed too: in Docker, `BRAND_NAME` is applied
to the web app manifest automatically; on a static host, edit `name` and
`short_name` in `manifest.webmanifest`. The install icons are the `pwa-*.png`
files - replace them (or mount over them) to change the icon art.

## Privacy

There is no server. When you open a file, the browser reads it **directly from your disk** (in small slices, so even multi-gigabyte mailboxes work) and all parsing, rendering, search, OCR, and PDF export happen on your device. Your mailbox is never uploaded. Like a normal mail client, an email that references **remote images** will fetch those from the sender's servers when you view it (invisible tracking pixels are stripped, but a visible remote image can still tell the sender you opened it). Each remote image is fetched only once and then cached locally in your browser, so re-viewing it does not ping the sender again. Apart from that, the only network use is loading the app itself.

## Tech

React + Vite + TypeScript + Tailwind. PST parsing via [`@hiraokahypertools/pst-extractor`](https://www.npmjs.com/package/@hiraokahypertools/pst-extractor), `.msg` parsing via [`@kenjiuno/msgreader`](https://www.npmjs.com/package/@kenjiuno/msgreader), and `.eml` parsing via [`postal-mime`](https://www.npmjs.com/package/postal-mime), all in a Web Worker. Search via MiniSearch, PDF rendering via pdf.js, spreadsheets via SheetJS, Word via docx-preview, OCR via Tesseract.js, zip handling via fflate, HTML sanitizing via DOMPurify, S/MIME (PKCS#7) parsing via node-forge. TNEF (winmail.dat) and MIME are parsed in-house. PWA via vite-plugin-pwa (Workbox).

## Known limitations

- **PowerPoint (`.pptx`/`.ppt`)** and **OpenDocument text (`.odt`)** attachments are download-only (no reliable in-browser renderer).
- **Encrypted S/MIME** messages can't be read without the recipient's private key (signed S/MIME is decoded and shown). This is real per-email encryption applied by the sender, unrelated to PST passwords, which don't encrypt anything and are not needed here.
- **Colour categories on standalone `.msg` files** are not shown (the `.msg` parser cannot decode multi-value properties); categories in PST/OST mailboxes display normally.
- **Corrupt or damaged mailboxes**: a partly-damaged file still opens and shows everything that is readable; messages that cannot be parsed are skipped and counted (a "N messages could not be read" note appears on the affected folder). A badly damaged file (broken header, truncated, or damaged internal index) is opened with **built-in recovery**: the file is scanned for surviving data structures and everything reachable is shown, marked with an amber badge. Only when recovery also finds nothing usable does the file fail to open; Microsoft's Inbox Repair Tool (`scanpst.exe`, bundled with Outlook) is then the last resort. Either way, other loaded mailboxes keep working. (Recovery covers modern Unicode PST/OST files; it does not cover ANSI-era files from Outlook 97-2002.)
- Search becomes available for a mailbox once its background indexing finishes (a progress indicator is shown).
- **Text inside images can be misread by OCR**, especially when it is very small or low-contrast. It also becomes searchable a little after the rest of a mailbox, since it is read in the background (a "Reading images" progress indicator shows while it runs).
- **Privacy browsers with canvas fingerprinting protection** (some hardened Chromium forks) scramble canvas pixel data, which breaks the image sharpening OCR relies on, so text inside images may not be searchable there. Body and text search still work everywhere. For image OCR, use a standard Chromium, or allow canvas/fingerprinting for the site.
