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
    // Hand the engine an uncompressed bitmap. PNG compression of an enlarged
    // image costs far more than the recognition itself (measured: about four
    // fifths of all OCR time), and the engine only wants the pixels back.
    const bmp = grayscaleBmp(ctx.getImageData(0, 0, w, h))
    if (bmp) return bmp
    const out = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'))
    return out || blob
  } catch {
    return blob
  }
}

/**
 * Pack already-grayscale pixels into an 8-bit BMP (bottom-up rows, 4-byte
 * aligned, 256-entry gray palette). Writing this is a copy rather than a
 * compression pass, which is the whole point. Returns null if anything about
 * the image is unexpected, so the caller can fall back to PNG.
 */
function grayscaleBmp(img: ImageData): Blob | null {
  try {
    const { width: w, height: h, data } = img
    if (!w || !h) return null
    const rowBytes = (w + 3) & ~3 // rows are padded to a 4-byte boundary
    const pixelOffset = 14 + 40 + 256 * 4
    const size = pixelOffset + rowBytes * h
    const buf = new ArrayBuffer(size)
    const view = new DataView(buf)
    const bytes = new Uint8Array(buf)

    view.setUint8(0, 0x42) // 'B'
    view.setUint8(1, 0x4d) // 'M'
    view.setUint32(2, size, true)
    view.setUint32(10, pixelOffset, true)
    view.setUint32(14, 40, true) // BITMAPINFOHEADER
    view.setInt32(18, w, true)
    view.setInt32(22, h, true)
    view.setUint16(26, 1, true) // planes
    view.setUint16(28, 8, true) // bits per pixel
    view.setUint32(34, rowBytes * h, true)
    view.setUint32(46, 256, true) // palette entries used

    for (let i = 0; i < 256; i++) {
      const p = 54 + i * 4
      bytes[p] = i // blue
      bytes[p + 1] = i // green
      bytes[p + 2] = i // red
    }
    // BMP rows run bottom-up; the source is already gray so any channel does.
    for (let y = 0; y < h; y++) {
      let out = pixelOffset + (h - 1 - y) * rowBytes
      let src = y * w * 4
      for (let x = 0; x < w; x++, src += 4) bytes[out++] = data[src]
    }
    return new Blob([buf], { type: 'image/bmp' })
  } catch {
    return null
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

/**
 * How many images to read at once.
 *
 * Recognition is CPU work that returns only a short string, so it scales with
 * the machine's cores. Two are left free for the UI and the parsing worker,
 * and the count is capped because each engine holds its own copy of the
 * recognition model.
 */
export function ocrConcurrency(): number {
  const cores = navigator.hardwareConcurrency || 2
  return Math.max(1, Math.min(4, cores - 2))
}

/** A pool of recognition engines, one per lane of work. */
export interface OcrPool {
  workers: TesseractWorker[]
  terminate: () => Promise<void>
}

/**
 * Start `size` engines. Engines that fail to start are simply absent, so OCR
 * still runs (just less parallel) rather than failing outright; null means
 * none could start at all.
 */
export async function createOcrPool(size: number): Promise<OcrPool | null> {
  const started = await Promise.all(
    Array.from({ length: Math.max(1, size) }, () => createOcrWorker().catch(() => null)),
  )
  const workers = started.filter((w): w is TesseractWorker => w !== null)
  if (!workers.length) return null
  return {
    workers,
    terminate: async () => {
      await Promise.all(
        workers.map((w) =>
          w.terminate().catch(() => {
            /* already gone */
          }),
        ),
      )
    },
  }
}
