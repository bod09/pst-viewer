import { extractMimeBody, type MimeBody } from './mime'

export type SmimeResult =
  | { kind: 'signed'; body: MimeBody }
  | { kind: 'encrypted' }
  | { kind: 'unsupported' }

const binaryString = (bytes: Uint8Array): string => {
  let s = ''
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  }
  return s
}

const stringToBytes = (s: string): Uint8Array => {
  const b = new Uint8Array(s.length)
  for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i) & 0xff
  return b
}

/**
 * Navigate a PKCS#7 ContentInfo ASN.1 to the SignedData's encapsulated content
 * (the original MIME message): ContentInfo -> [0] SignedData -> encapContentInfo
 * -> [0] eContent (an OCTET STRING, possibly chunked). Returns it as a byte string.
 */
function findSignedEContent(asn1: { value: unknown }): string | null {
  try {
    const ci = asn1 as { value: Array<{ value: unknown }> }
    const signedData = (ci.value[1] as { value: Array<{ value: unknown }> }).value[0] as {
      value: Array<{ value: unknown }>
    }
    const eci = signedData.value[2] as { value: Array<{ value: unknown }> }
    const explicit = eci.value[1] as { value: Array<{ constructed?: boolean; value: unknown }> }
    const node = explicit.value[0] as { constructed?: boolean; value: unknown }
    if (node.constructed) {
      return (node.value as Array<{ value: string }>).map((c) => c.value).join('')
    }
    return node.value as string
  } catch {
    return null
  }
}

/** Recover the readable body of an S/MIME message from its smime.p7m bytes. */
export async function extractSmime(p7mBytes: ArrayBuffer): Promise<SmimeResult> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mod: any = await import('node-forge')
    const forge = mod.default ?? mod
    const asn1 = forge.asn1.fromDer(forge.util.createBuffer(binaryString(new Uint8Array(p7mBytes))))
    const oid = forge.asn1.derToOid(asn1.value[0].value)
    if (oid === forge.pki.oids.envelopedData || oid === forge.pki.oids.encryptedData) {
      return { kind: 'encrypted' }
    }
    if (oid !== forge.pki.oids.signedData) return { kind: 'unsupported' }
    const eContent = findSignedEContent(asn1)
    if (!eContent) return { kind: 'unsupported' }
    return { kind: 'signed', body: extractMimeBody(stringToBytes(eContent)) }
  } catch {
    return { kind: 'unsupported' }
  }
}
