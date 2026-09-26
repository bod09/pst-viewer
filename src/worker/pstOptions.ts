import type { PrimitiveTypeConverter, PSTOpts } from '@hiraokahypertools/pst-extractor'

// The parser does not support PT_MV_I8 (0x1014) yet. In a PST property
// context, its heap value is a packed sequence of little-endian 64-bit ints.
const convertMultiInteger64: PrimitiveTypeConverter = async ({ view, resolveHeap }) => {
  const heap = view.getUint32(0, true)
  if (heap === 0) return []

  const bytes = await resolveHeap(heap)
  if (bytes === undefined) return []
  if (bytes.byteLength % 8 !== 0) {
    throw new Error(`Invalid PT_MV_I8 length: ${bytes.byteLength} bytes`)
  }

  const values: bigint[] = []
  const data = new DataView(bytes)
  for (let offset = 0; offset < bytes.byteLength; offset += 8) {
    values.push(data.getBigInt64(offset, true))
  }
  return values
}

export const pstOptions: PSTOpts = {
  provideFallbackTypeConverterOf: (type) =>
    type === 0x1014 ? convertMultiInteger64 : undefined,
}
