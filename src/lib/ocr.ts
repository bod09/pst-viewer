import { createWorker, type Worker as TesseractWorker } from 'tesseract.js'

/**
 * Create a Tesseract worker pointed at our locally-bundled engine + English
 * model (so OCR works fully offline). Lazy-imported so the engine only loads
 * when the user opts in.
 */
export function createOcrWorker(): Promise<TesseractWorker> {
  // Base-aware so the bundled engine/model resolve under any deploy path
  // (root domain, or a GitHub Pages subpath like /pst-viewer/).
  const base = import.meta.env.BASE_URL
  return createWorker('eng', 1, {
    workerPath: `${base}tesseract/worker.min.js`,
    corePath: `${base}tesseract`,
    langPath: `${base}tesseract/tessdata`,
  })
}

// Upscaling small text is the single biggest OCR-accuracy win, but bigger images
// cost more time, so cap the working size. This runs only during background OCR
// (never during PST load), one image at a time.
const MAX_OCR_PIXELS = 8_000_000

// Privacy browsers (canvas fingerprinting protection) perturb the pixels you
// read back from a canvas. That silently corrupts the sharpened image, so OCR
// of small text fails there. Detect it once: draw a known colour and read it
// back; if it doesn't come back exactly, the browser is scrambling canvas data
// and we must not sharpen (we recognise the original image instead).
let canvasReliable: boolean | null = null
function canvasReadbackReliable(): boolean {
  if (canvasReliable !== null) return canvasReliable
  try {
    if (typeof document === 'undefined') return (canvasReliable = false)
    const c = document.createElement('canvas')
    c.width = 4
    c.height = 4
    const ctx = c.getContext('2d', { willReadFrequently: true })
    if (!ctx) return (canvasReliable = false)
    ctx.fillStyle = 'rgb(10,20,30)'
    ctx.fillRect(0, 0, 4, 4)
    const d = ctx.getImageData(1, 1, 1, 1).data
    return (canvasReliable = d[0] === 10 && d[1] === 20 && d[2] === 30 && d[3] === 255)
  } catch {
    return (canvasReliable = false)
  }
}

/**
 * Prepare an image for OCR: enlarge it (so small digits/letters have enough
 * pixels to recognise) and convert to high-contrast grayscale. The engine
 * decodes the returned blob off the main thread, keeping the UI responsive.
 * If the browser scrambles canvas readback, or anything is unsupported/fails,
 * the original blob is returned unchanged.
 */
async function preprocessForOcr(blob: Blob): Promise<Blob> {
  try {
    if (typeof createImageBitmap !== 'function' || !canvasReadbackReliable()) return blob
    const bitmap = await createImageBitmap(blob)
    const w0 = bitmap.width
    const h0 = bitmap.height
    if (!w0 || !h0) {
      bitmap.close?.()
      return blob
    }
    // Upscale ~2x, but never past the pixel cap (and never downscale).
    let scale = 2
    const px = w0 * h0
    if (px * scale * scale > MAX_OCR_PIXELS) scale = Math.max(1, Math.sqrt(MAX_OCR_PIXELS / px))
    const w = Math.round(w0 * scale)
    const h = Math.round(h0 * scale)

    const canvas = document.createElement('canvas')
    canvas.width = w
    canvas.height = h
    const ctx = canvas.getContext('2d')
    if (!ctx) {
      bitmap.close?.()
      return blob
    }
    ctx.imageSmoothingEnabled = true
    ctx.imageSmoothingQuality = 'high'
    ctx.filter = 'grayscale(1) contrast(1.25)'
    ctx.drawImage(bitmap, 0, 0, w, h)
    bitmap.close?.()
    const out = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'))
    return out || blob
  } catch {
    return blob
  }
}

/** Recognize text in an image blob; returns normalized text ('' on failure). */
export async function recognizeImage(worker: TesseractWorker, blob: Blob): Promise<string> {
  try {
    const image = await preprocessForOcr(blob)
    const result = await worker.recognize(image)
    return (result.data.text ?? '').replace(/\s+/g, ' ').trim()
  } catch {
    return ''
  }
}
