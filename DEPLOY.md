# Deploying PST Viewer

PST Viewer is a **static site** (a single-page app with a service worker). There is
no backend, no database, and nothing to upload at runtime: mailboxes are read and
processed entirely in the visitor's browser. To deploy it, either grab the
**prebuilt Docker image** ([Option B](#option-b-docker-prebuilt-image-hardened-by-default) -
no Node needed), or build it once and serve the resulting folder of files.

> **HTTPS is required** for the offline / installable (PWA) features. Every option
> below either provides HTTPS automatically or assumes you have a certificate.

## Build it

Requires [Node.js](https://nodejs.org) 20.19+ (or 22+).

```bash
npm install        # first time only
npm run build      # outputs static files to dist/
```

Upload the **contents of `dist/`** to any static host. That's the whole app.

### The one gotcha: base path

- **Root of a domain** (e.g. `https://mail.example.com/`) - use the normal
  `npm run build`. This is the default and works for Caddy, Nginx, Netlify,
  Vercel, Cloudflare, S3, and GitHub Pages **with a custom domain**.
- **A sub-path** (e.g. GitHub Pages project sites at
  `https://user.github.io/pst-viewer/`) - build with the path set:
  ```bash
  BASE_PATH=/pst-viewer/ npm run build      # macOS/Linux
  # Windows PowerShell:  $env:BASE_PATH='/pst-viewer/'; npm run build
  ```
  The included GitHub Actions workflow does this for you automatically.

---

## Option A: GitHub Pages (zero-config, via the included workflow)

This repo ships with `.github/workflows/deploy.yml`, which builds and publishes to
Pages on every push to `main`.

1. Fork or use this repo (it must be **public** for free GitHub Pages).
2. In the repo: **Settings -> Pages -> Build and deployment -> Source: GitHub Actions**.
3. Push to `main` (or run the "Deploy to GitHub Pages" workflow manually).
4. Your site appears at `https://<your-user>.github.io/pst-viewer/`.

**Custom domain:** add it under Settings -> Pages. If it serves from the domain
root, edit the workflow's `BASE_PATH` to `/` (and add a `CNAME`).

---

## Option B: Docker (prebuilt image, hardened by default)

Every push to `main` publishes a ready-built image to GitHub Container Registry
(via `.github/workflows/docker.yml`), so this path needs **no Node and no build
step**:

```bash
docker run -d --name pst-viewer -p 8080:8080 \
  --read-only --tmpfs /tmp \
  --cap-drop ALL --security-opt no-new-privileges \
  ghcr.io/bod09/pst-viewer:latest
```

Or with compose (this file ships in the repo as `docker/compose.yaml`):

```yaml
services:
  pst-viewer:
    image: ghcr.io/bod09/pst-viewer:latest
    ports:
      - "8080:8080"
    read_only: true
    tmpfs:
      - /tmp                 # nginx pid file and temp buffers
    cap_drop:
      - ALL
    security_opt:
      - no-new-privileges:true
    pids_limit: 64
    restart: unless-stopped
```

Then open <http://localhost:8080>.

The image is hardened by default, and the app is fully functional under it.
Because the privacy claim ("mailboxes never leave your device") matters here,
the restrictions are enforceable rather than a matter of trust:

- nginx serves a **Content-Security-Policy** under which the browser blocks
  page scripts from contacting any other server (`connect-src 'self'`) and
  from loading third-party code (`script-src 'self'`). The one exception is
  images referenced inside emails you open (`img-src https: http:`); to block
  those too, remove the two tokens in `docker/security-headers.conf` and
  rebuild.
- The container runs as a non-root user with all Linux capabilities dropped, a
  read-only root filesystem (only an in-memory `/tmp` is writable),
  `no-new-privileges`, and a PID limit.

**HTTPS:** the container serves plain HTTP on 8080. `http://localhost:8080` is
a secure context, so everything including the installable/offline PWA works
locally. To serve other machines, put it behind an HTTPS reverse proxy (Caddy,
Traefik, Nginx); PWA features require HTTPS on non-localhost origins.

**Branding:** set environment variables to rebrand the deployment; the logo is
a URL, so either mount the image file or point at a hosted one. (Mounting a
full `branding.json` works too - see the Branding section in README.md.)

```yaml
    environment:
      BRAND_NAME: "Acme Mail Archive"
      BRAND_TAGLINE: "Internal use only"
      BRAND_ACCENT: "#7c3aed"
      BRAND_LOGO: "/logo.svg"
    volumes:
      - ./logo.svg:/usr/share/nginx/html/logo.svg:ro
```

**Building it yourself** gives an identical result: `docker build -t pst-viewer .`
in the repo root. Forks publish their own image at
`ghcr.io/<your-user>/pst-viewer`; if the package comes out private, set it to
public in its settings on GitHub so anonymous `docker pull` works.

---

## Option C: Caddy (recommended for self-hosting)

`npm run deploy` assembles a drop-in `deploy/` folder (`site/` + `Caddyfile` +
this guide). Copy it to your server, set your domain in the `Caddyfile`, and run
Caddy. Auto-HTTPS is included.

```caddy
pst.example.com {
    root * /srv/pst-viewer/site
    encode zstd gzip
    file_server
    try_files {path} /index.html
}
```

Run `caddy run` from the folder, or paste the block into your system Caddyfile and
`caddy reload`. To restrict access to staff, add a `basic_auth` block (generate a
hash with `caddy hash-password`) or limit by IP / VPN.

---

## Option D: Nginx

Serve the build folder and fall back to `index.html`:

```nginx
server {
    listen 443 ssl;
    server_name pst.example.com;
    # ssl_certificate / ssl_certificate_key ...

    root /srv/pst-viewer;   # the contents of dist/
    index index.html;

    location / {
        try_files $uri /index.html;
    }
}
```

Make sure `application/wasm` is in your `mime.types` (modern Nginx includes it).
Do **not** enable `gzip_static` for `eng.traineddata.gz`; that file must be served
as-is (the app decompresses it itself).

---

## Option E: Netlify / Vercel / Cloudflare Pages

Connect the repo (or drag-and-drop the `dist/` folder for a manual deploy):

| Setting          | Value           |
| ---------------- | --------------- |
| Build command    | `npm run build` |
| Publish / output | `dist`          |

These serve from the domain root, so no `BASE_PATH` is needed. They provide HTTPS
automatically. (Optional SPA fallback: a `_redirects` file with `/* /index.html 200`
for Netlify; the others detect Vite automatically.)

---

## Option F: Any static host / object storage (S3, Azure Blob, etc.)

Upload the contents of `dist/` and serve `index.html` as the default document.
Put it behind HTTPS (a CDN like CloudFront / Cloudflare in front is fine).

---

## Serving notes (rarely needed, but good to know)

- `.wasm` files must be served as `application/wasm`, and `.mjs` as JavaScript.
  Modern static servers and CDNs do this out of the box.
- `eng.traineddata.gz` (the bundled OCR model) must be delivered as a plain file.
  Don't configure the server to add a `Content-Encoding: gzip` header to it.
- A fallback to `index.html` for unknown paths is nice to have but not required,
  since the app has no server-side routes.

## Updating

Rebuild and re-upload. Visitors update automatically on their next load (the
service worker refreshes itself).

## Privacy

There is no backend. The server only ever sends the static app files; mailbox
contents never leave the visitor's device.
