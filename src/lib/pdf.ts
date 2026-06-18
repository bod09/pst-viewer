import * as pdfjs from 'pdfjs-dist'
// Bundle pdf.js's worker and point the library at it (Vite ?url import).
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl

export { pdfjs }
