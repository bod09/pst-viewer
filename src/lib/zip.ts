import { unzip, type Unzipped, type UnzipFileInfo } from 'fflate'

export interface ExtractedPst {
  name: string
  path: string
  file: File
}

export interface ZipScanResult {
  /** Every PST/OST found, at any folder depth and inside nested zips. */
  psts: ExtractedPst[]
  /** Names of other (non-PST) files found, for a helpful "wrong zip" message. */
  otherFiles: string[]
}

const PST_ENTRY = /\.(pst|ost)$/i
const ZIP_ENTRY = /\.zip$/i
// Guard against zip bombs / pathological nesting when recursing into zips.
const MAX_DEPTH = 4
const OTHER_FILES_CAP = 50

/** Directory placeholders, macOS resource forks, and dotfiles aren't real content. */
function isJunkEntry(name: string): boolean {
  const base = name.split('/').pop() ?? name
  return name.endsWith('/') || name.includes('__MACOSX') || base.startsWith('.')
}

/**
 * Find and extract every PST/OST inside a zip, at any folder depth and inside
 * nested zips. Only matching entries (and nested zips, to recurse into) are
 * decompressed (fflate `filter`), and the work runs off the main thread via
 * fflate's async worker.
 */
export async function scanZipForPsts(zipFile: File): Promise<ZipScanResult> {
  const psts: ExtractedPst[] = []
  const otherFiles: string[] = []

  const scan = async (buf: Uint8Array, depth: number): Promise<void> => {
    const data = await new Promise<Unzipped>((resolve, reject) => {
      unzip(
        buf,
        {
          filter: (f: UnzipFileInfo) => {
            if (isJunkEntry(f.name)) return false
            const isPst = PST_ENTRY.test(f.name)
            const isZip = ZIP_ENTRY.test(f.name)
            if (!isPst && !isZip && otherFiles.length < OTHER_FILES_CAP) {
              otherFiles.push(f.name.split('/').pop() || f.name)
            }
            // Decompress PSTs always; nested zips only while within the depth cap.
            return isPst || (isZip && depth < MAX_DEPTH)
          },
        },
        (err, out) => (err ? reject(err) : resolve(out)),
      )
    })

    for (const path of Object.keys(data)) {
      const bytes = data[path]
      if (!bytes || bytes.length === 0) continue
      if (PST_ENTRY.test(path)) {
        const name = path.split('/').pop() || path
        psts.push({ name, path, file: new File([bytes], name) })
      } else if (ZIP_ENTRY.test(path) && depth < MAX_DEPTH) {
        await scan(bytes, depth + 1)
      }
    }
  }

  await scan(new Uint8Array(await zipFile.arrayBuffer()), 0)
  return { psts, otherFiles }
}
