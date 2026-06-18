import { createWorker, type Worker as TesseractWorker } from 'tesseract.js'

/**
 * Create a Tesseract worker pointed at our locally-bundled engine + English
 * model (so OCR works fully offline). Lazy-imported so the engine only loads
 * when the user opts in.
 */
export function createOcrWorker(): Promise<TesseractWorker> {
  return createWorker('eng', 1, {
    workerPath: '/tesseract/worker.min.js',
    corePath: '/tesseract',
    langPath: '/tesseract/tessdata',
  })
}

/** Recognize text in an image blob; returns normalized text ('' on failure). */
export async function recognizeImage(worker: TesseractWorker, blob: Blob): Promise<string> {
  try {
    const result = await worker.recognize(blob)
    return (result.data.text ?? '').replace(/\s+/g, ' ').trim()
  } catch {
    return ''
  }
}
