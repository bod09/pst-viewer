import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { VitePWA } from 'vite-plugin-pwa'

// Node global (vite.config runs in Node); declared locally to avoid @types/node.
declare const process: { env: Record<string, string | undefined> }
// `self` is referenced only inside the service-worker route below, which Workbox
// serializes into the generated SW; declared so this Node-context file type-checks.
declare const self: { location: { origin: string } }

// Default '/' (root domains, Caddy, Nginx, Netlify, etc.). GitHub Pages project
// sites are served from a subpath, so the CI build sets BASE_PATH=/pst-viewer/.
const base = process.env.BASE_PATH || '/'

export default defineConfig({
  base,
  resolve: {
    alias: {
      // msgreader pulls in iconv-lite, which needs Node's Buffer; swap in a
      // small TextDecoder-based shim (see src/lib/iconv-lite-shim.ts).
      'iconv-lite': new URL('./src/lib/iconv-lite-shim.ts', import.meta.url).pathname,
    },
  },
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['icon.svg', 'apple-touch-icon.png'],
      manifest: {
        name: 'PST Viewer',
        short_name: 'PST Viewer',
        description: 'View Outlook PST/OST mailboxes locally in your browser. Nothing is uploaded.',
        theme_color: '#0b1220',
        background_color: '#020617',
        display: 'standalone',
        // Relative so it resolves correctly at both '/' and '/pst-viewer/'.
        start_url: '.',
        icons: [
          { src: 'pwa-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: 'pwa-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          { src: 'pwa-192-maskable.png', sizes: '192x192', type: 'image/png', purpose: 'maskable' },
          { src: 'pwa-512-maskable.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        // Precache the app shell + workers (incl. pdf.js .mjs) + OCR engine/model
        // (.wasm/.gz) so everything — including image OCR — works fully offline.
        globPatterns: ['**/*.{js,mjs,css,html,svg,png,wasm,gz,woff,woff2}'],
        maximumFileSizeToCacheInBytes: 8 * 1024 * 1024,
        cleanupOutdatedCaches: true,
        runtimeCaching: [
          {
            // Runtime branding file: network-first so a changed deployment
            // shows up on next load, cached so offline installs keep it.
            urlPattern: ({ url }) =>
              url.origin === self.location.origin && url.pathname.endsWith('/branding.json'),
            handler: 'NetworkFirst',
            options: { cacheName: 'branding' },
          },
          {
            // Cache remote email images locally, the way an email client proxies
            // them. The service worker can store cross-origin ("opaque")
            // responses, so each remote image loads once then is served from the
            // cache forever after: it stops them disappearing / being throttled,
            // and a shared image used by many emails is fetched only once.
            urlPattern: ({ url, request }) =>
              request.destination === 'image' && url.origin !== self.location.origin,
            handler: 'CacheFirst',
            options: {
              cacheName: 'remote-email-images',
              expiration: {
                maxEntries: 300,
                maxAgeSeconds: 60 * 60 * 24 * 30,
                purgeOnQuotaError: true,
              },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
        ],
      },
    }),
  ],
  // ES-module workers so we can `import` inside the parsing worker.
  worker: {
    format: 'es',
  },
})
