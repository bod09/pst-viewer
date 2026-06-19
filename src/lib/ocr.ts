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

/**
 * Prepare an image for OCR: enlarge it (so small digits/letters have enough
 * pixels to recognise) and convert to high-contrast grayscale. Returns a
 * <canvas> for the engine to read, NOT a re-encoded blob, because the
 * `canvas.toBlob()` / `toDataURL()` step is exactly what privacy browsers
 * (canvas fingerprinting protection) block or scramble. The upscale itself uses
 * `createImageBitmap` + `drawImage`, which those browsers leave alone. Falls
 * back to the original blob if anything is unsupported or fails.
 */
async function preprocessForOcr(blob: Blob): Promise<Blob | HTMLCanvasElement> {
  try {
    if (typeof document === 'undefined' || typeof createImageBitmap !== 'function') return blob
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
    return canvas
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
