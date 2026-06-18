// One-off: rasterize the SVG logo into the PNG icons the PWA manifest needs.
import sharp from 'sharp'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const pub = join(root, 'public')
const svg = readFileSync(join(pub, 'icon.svg'))

await sharp(svg).resize(192, 192).png().toFile(join(pub, 'pwa-192.png'))
await sharp(svg).resize(512, 512).png().toFile(join(pub, 'pwa-512.png'))
await sharp(svg).resize(180, 180).png().toFile(join(pub, 'apple-touch-icon.png'))
// Maskable: logo inset on the brand background so it survives icon masking.
await sharp(svg)
  .resize(360, 360)
  .extend({ top: 76, bottom: 76, left: 76, right: 76, background: '#0b1220' })
  .png()
  .toFile(join(pub, 'pwa-512-maskable.png'))

console.log('Generated PWA PNG icons in public/')
