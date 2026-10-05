import { describe, expect, test } from 'vitest'
import { structuredAddresses } from '../../src/worker/eml'

describe('structuredAddresses', () => {
  test('reads ordinary addresses', () => {
    expect(structuredAddresses('Alice Example <alice@example.com>, bob@example.com')).toEqual([
      { name: 'Alice Example', address: 'alice@example.com' },
      { name: '', address: 'bob@example.com' },
    ])
  })

  test('decodes an encoded name', () => {
    expect(structuredAddresses('=?UTF-8?B?w4lsb8Ovc2U=?= <eloise@example.com>')).toEqual([
      { name: 'Éloïse', address: 'eloise@example.com' },
    ])
    expect(structuredAddresses('=?ISO-8859-1?Q?Andr=E9_Dupont?= <andre@example.com>')).toEqual([
      { name: 'André Dupont', address: 'andre@example.com' },
    ])
  })

  test('adjacent encoded words are one piece of text', () => {
    expect(
      structuredAddresses('=?UTF-8?Q?Jos=C3=A9?= =?UTF-8?Q?_Garc=C3=ADa?= <jose@example.com>'),
    ).toEqual([{ name: 'José García', address: 'jose@example.com' }])
  })

  // The reason this function exists: an encoded word is only ever display
  // text, whatever it decodes to.
  test.each([
    [
      'an address inside the encoded name',
      '=?UTF-8?Q?IT_Support_<helpdesk@company.example>?= <attacker@evil.example>',
      { name: 'IT Support <helpdesk@company.example>', address: 'attacker@evil.example' },
    ],
    [
      'base64 instead of quoted-printable',
      `=?UTF-8?B?${Buffer.from('Boss <ceo@company.example>').toString('base64')}?= <attacker@evil.example>`,
      { name: 'Boss <ceo@company.example>', address: 'attacker@evil.example' },
    ],
    [
      'a quoted address and a comma inside the encoded name',
      '=?UTF-8?Q?"ceo@company.example"=2C_<ceo@company.example>?= <attacker@evil.example>',
      { name: '"ceo@company.example", <ceo@company.example>', address: 'attacker@evil.example' },
    ],
    [
      'lower-case encoding letter and charset',
      '=?utf-8?q?Boss_<ceo@company.example>?= <attacker@evil.example>',
      { name: 'Boss <ceo@company.example>', address: 'attacker@evil.example' },
    ],
  ])('the address outside the encoded words is the sender: %s', (_what, header, expected) => {
    expect(structuredAddresses(header)).toEqual([expected])
  })

  test('an encoded word cannot add a recipient', () => {
    const list = structuredAddresses(
      '=?UTF-8?Q?Bob_<bob@example.com>,_Eve_<eve@evil.example>?= <intern@example.com>',
    )
    expect(list).toEqual([
      { name: 'Bob <bob@example.com>, Eve <eve@evil.example>', address: 'intern@example.com' },
    ])
  })

  test('an encoded word inside an address is kept as written, not decoded into one', () => {
    const [box] = structuredAddresses('Name <=?UTF-8?Q?ceo@company.example?=>')
    expect(box.address).not.toBe('ceo@company.example')
    expect(box.address).toContain('=?UTF-8?Q?')
  })

  test('with no address outside the encoded word, the one inside is used', () => {
    // Some mailers encode a whole "Name <address>" in one go.
    expect(structuredAddresses('=?UTF-8?Q?Alice_Example_<alice@example.com>?=')).toEqual([
      { name: 'Alice Example', address: 'alice@example.com' },
    ])
    expect(structuredAddresses('=?UTF-8?B?w4lsb8Ovc2U=?=')).toEqual([{ name: 'Éloïse', address: '' }])
  })

  test('groups keep their members', () => {
    const [group] = structuredAddresses(
      'Team: =?UTF-8?Q?Ann_<x@evil.example>?= <ann@example.com>, bob@example.com;',
    )
    expect(group.name).toBe('Team')
    expect(group.group).toEqual([
      { name: 'Ann <x@evil.example>', address: 'ann@example.com' },
      { name: '', address: 'bob@example.com' },
    ])
  })

  test('text that merely looks like the internal placeholder is left alone', () => {
    expect(structuredAddresses('pstvencoded0x <alice@example.com>')).toEqual([
      { name: 'pstvencoded0x', address: 'alice@example.com' },
    ])
    expect(structuredAddresses('pstvencoded0x =?UTF-8?Q?Real?= <alice@example.com>')).toEqual([
      { name: 'pstvencoded0x Real', address: 'alice@example.com' },
    ])
    expect(
      structuredAddresses('=?UTF-8?Q?Real?= <pstvencoded0x@example.com>, pstvencodedq0x <b@example.com>'),
    ).toEqual([
      { name: 'Real', address: 'pstvencoded0x@example.com' },
      { name: 'pstvencodedq0x', address: 'b@example.com' },
    ])
  })

  test('nonsense in, nothing dangerous out', () => {
    expect(structuredAddresses('')).toEqual([])
    for (const junk of ['<<<>>>', '=?', '=?UTF-8?Q??=', '=?UTF-8?X?abc?= <a@example.com>', ',;:,']) {
      expect(() => structuredAddresses(junk)).not.toThrow()
    }
  })
})
