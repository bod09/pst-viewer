import { unzip, type Unzipped, type UnzipFileInfo } from 'fflate'

export interface ExtractedPst {
  name: string
  path: string
  file: File
}

const PST_ENTRY = /\.(pst|ost)$/i

/**
 * Find and extract every PST/OST inside a zip (recursively, any nesting).
 * Only matching entries are decompressed (fflate `filter`), and the work runs
 * off the main thread via fflate's async worker.
 */
export async function extractPstsFromZip(zipFile: File): Promise<ExtractedPst[]> {
  const buf = new Uint8Array(await zipFile.arrayBuffer())
  const data = await new Promise<Unzipped>((resolve, reject) => {
    unzip(
      buf,
      {
        filter: (f: UnzipFileInfo) => PST_ENTRY.test(f.name) && !f.name.includes('__MACOSX'),
      },
      (err, out) => (err ? reject(err) : resolve(out)),
    )
  })

  const results: ExtractedPst[] = []
  for (const path of Object.keys(data)) {
    const bytes = data[path]
    if (!bytes || bytes.length === 0) continue
    const name = path.split('/').pop() || path
    results.push({ name, path, file: new File([bytes], name) })
  }
  return results
}
