import { unzip, type Unzipped, type UnzipFileInfo } from 'fflate'

export interface ExtractedPst {
  name: string
  path: string
  file: File
}

export interface ZipScanResult {
  /** Every PST/OST found, at any folder depth and inside nested zips. */
  psts: ExtractedPst[]
  /** Every standalone .msg/.eml message found. */
  msgs: ExtractedPst[]
  /** Names of other (non-mailbox) files found, for a helpful "wrong zip" message. */
  otherFiles: string[]
}

const PST_ENTRY = /\.(pst|ost)$/i
const MSG_ENTRY = /\.(msg|eml)$/i
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
  // Files unpacked from a zip inherit the zip's own timestamp, so reopening
  // the same archive recognises them again. Stamping them with the current
  // time instead would miss the search-index cache on every open and store
  // another full copy of the index each time.
  const srcModified = zipFile.lastModified
  const psts: ExtractedPst[] = []
  const msgs: ExtractedPst[] = []
  const otherFiles: string[] = []

  const scan = async (buf: Uint8Array, depth: number): Promise<void> => {
    const data = await new Promise<Unzipped>((resolve, reject) => {
      unzip(
        buf,
        {
          filter: (f: UnzipFileInfo) => {
            if (isJunkEntry(f.name)) return false
            const isMailbox = PST_ENTRY.test(f.name) || MSG_ENTRY.test(f.name)
            const isZip = ZIP_ENTRY.test(f.name)
            if (!isMailbox && !isZip && otherFiles.length < OTHER_FILES_CAP) {
              otherFiles.push(f.name.split('/').pop() || f.name)
            }
            // Decompress mailboxes always; nested zips only within the depth cap.
            return isMailbox || (isZip && depth < MAX_DEPTH)
          },
        },
        (err, out) => (err ? reject(err) : resolve(out)),
      )
    })

    for (const path of Object.keys(data)) {
      const bytes = data[path]
      if (!bytes || bytes.length === 0) continue
      const name = path.split('/').pop() || path
      if (PST_ENTRY.test(path)) {
        psts.push({ name, path, file: new File([bytes], name, { lastModified: srcModified }) })
      } else if (MSG_ENTRY.test(path)) {
        msgs.push({ name, path, file: new File([bytes], name, { lastModified: srcModified }) })
      } else if (ZIP_ENTRY.test(path) && depth < MAX_DEPTH) {
        await scan(bytes, depth + 1)
      }
    }
  }

  await scan(new Uint8Array(await zipFile.arrayBuffer()), 0)
  return { psts, msgs, otherFiles }
}
