import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { VitePWA } from 'vite-plugin-pwa'

// Node global (vite.config runs in Node); declared locally to avoid @types/node.
declare const process: { env: Record<string, string | undefined> }

// Default '/' (root domains, Caddy, Nginx, Netlify, etc.). GitHub Pages project
// sites are served from a subpath, so the CI build sets BASE_PATH=/pst-viewer/.
const base = process.env.BASE_PATH || '/'

export default defineConfig({
  base,
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
          { src: 'pwa-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'pwa-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'pwa-512-maskable.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        // Precache the app shell + workers (incl. pdf.js .mjs) + OCR engine/model
        // (.wasm/.gz) so everything — including image OCR — works fully offline.
        globPatterns: ['**/*.{js,mjs,css,html,svg,png,wasm,gz,woff,woff2}'],
        maximumFileSizeToCacheInBytes: 8 * 1024 * 1024,
        cleanupOutdatedCaches: true,
      },
    }),
  ],
  // ES-module workers so we can `import` inside the parsing worker.
  worker: {
    format: 'es',
  },
})
