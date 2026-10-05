import forge from 'node-forge'
import { describe, expect, test } from 'vitest'
import { extractSmime } from '../../src/lib/smime'

const { asn1, pki } = forge
const C = asn1.Class
const T = asn1.Type

const oid = (id: string) => asn1.create(C.UNIVERSAL, T.OID, false, asn1.oidToDer(id).getBytes())
const seq = (...items: forge.asn1.Asn1[]) => asn1.create(C.UNIVERSAL, T.SEQUENCE, true, items)
const set = (...items: forge.asn1.Asn1[]) => asn1.create(C.UNIVERSAL, T.SET, true, items)
const octets = (bytes: string) => asn1.create(C.UNIVERSAL, T.OCTETSTRING, false, bytes)
const explicit0 = (...items: forge.asn1.Asn1[]) => asn1.create(C.CONTEXT_SPECIFIC, 0, true, items)

/** DER bytes of a PKCS#7 ContentInfo of the given type around `inner`. */
function contentInfo(type: string, inner: forge.asn1.Asn1): ArrayBuffer {
  const der = asn1.toDer(seq(oid(type), explicit0(inner))).getBytes()
  return Uint8Array.from(der, (c) => c.charCodeAt(0)).buffer
}

/** A signed envelope around `eContent` (signatures left out: they are not read). */
function signed(eContent: forge.asn1.Asn1): ArrayBuffer {
  const version = asn1.create(C.UNIVERSAL, T.INTEGER, false, '\x01')
  const signedData = seq(version, set(), seq(oid(pki.oids.data), explicit0(eContent)), set())
  return contentInfo(pki.oids.signedData, signedData)
}

const MESSAGE =
  'Content-Type: multipart/mixed; boundary="B"\r\n\r\n' +
  '--B\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nSigned body: tamarillo.\r\n' +
  '--B\r\nContent-Type: text/csv\r\nContent-Disposition: attachment; filename="inside.csv"\r\n\r\na,b\r\n' +
  '--B--\r\n'

describe('extractSmime', () => {
  test('a signed message gives up the message inside it', async () => {
    const result = await extractSmime(signed(octets(MESSAGE)))
    expect(result.kind).toBe('signed')
    if (result.kind !== 'signed') return
    expect(result.body.text).toBe('Signed body: tamarillo.')
    expect(result.body.attachments.map((a) => a.name)).toEqual(['inside.csv'])
  })

  test('content stored in several chunks is joined', async () => {
    const chunked = asn1.create(C.UNIVERSAL, T.OCTETSTRING, true, [
      octets(MESSAGE.slice(0, 50)),
      octets(MESSAGE.slice(50, 120)),
      octets(MESSAGE.slice(120)),
    ])
    const result = await extractSmime(signed(chunked))
    expect(result.kind === 'signed' && result.body.text).toBe('Signed body: tamarillo.')
  })

  test('an encrypted message is reported as encrypted, not as broken', async () => {
    expect(await extractSmime(contentInfo(pki.oids.envelopedData, seq()))).toEqual({ kind: 'encrypted' })
    expect(await extractSmime(contentInfo(pki.oids.encryptedData, seq()))).toEqual({ kind: 'encrypted' })
  })

  test('anything else is unsupported, without an error', async () => {
    const unsupported = { kind: 'unsupported' }
    expect(await extractSmime(contentInfo(pki.oids.data, octets('x')))).toEqual(unsupported)
    expect(await extractSmime(contentInfo(pki.oids.signedData, seq()))).toEqual(unsupported)
    expect(await extractSmime(new TextEncoder().encode('not asn.1 at all').buffer as ArrayBuffer)).toEqual(unsupported)
    expect(await extractSmime(new ArrayBuffer(0))).toEqual(unsupported)
  })
})
