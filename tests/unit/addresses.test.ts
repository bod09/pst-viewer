import { describe, expect, test } from 'vitest'
import { parseEml, structuredAddresses } from '../../src/worker/eml'
import { simpleEml } from '../support/fixtures.mjs'

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

  // Shapes found in review: the fake address sits in an entry of its own, in
  // front of the real one, so there is no address beside it to contradict it.
  test.each([
    ['a name holding an address, then a comma', '=?UTF-8?Q?Boss_<boss@company.example>?=, <attacker@evil.example>'],
    ['a bare address in an encoded word, then a comma', '=?UTF-8?Q?boss@company.example?=, attacker@evil.example'],
    ['the same in base64', `=?UTF-8?B?${Buffer.from('boss@company.example').toString('base64')}?=, attacker@evil.example`],
    ['inside a group', 'People: =?UTF-8?Q?Boss_<boss@company.example>?=, attacker@evil.example;'],
  ])('text in an encoded word is never an address when the header has a real one: %s', (_what, header) => {
    const flat = structuredAddresses(header).flatMap((a) => a.group ?? [a])
    expect(flat.map((m) => m.address).filter(Boolean)).toEqual(['attacker@evil.example'])
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

  test('nothing the sender writes can pass for the token used while parsing', () => {
    // Encoded words are swapped for a token while the structure is read. An
    // earlier version used a fixed word, which a header could contain.
    expect(structuredAddresses('pstvencoded0x <alice@example.com>')).toEqual([
      { name: 'pstvencoded0x', address: 'alice@example.com' },
    ])
    expect(structuredAddresses('pstvencoded0x =?UTF-8?Q?Real?= <alice@example.com>')).toEqual([
      { name: 'pstvencoded0x Real', address: 'alice@example.com' },
    ])
    // Not even escaped, which the parser undoes after the header was looked at.
    expect(
      structuredAddresses('"pstvenco\\ded0x" <victim@example.com>, =?utf-8?q?Boss?= <b@example.com>'),
    ).toEqual([
      { name: 'pstvencoded0x', address: 'victim@example.com' },
      { name: 'Boss', address: 'b@example.com' },
    ])
  })

  test('a very long header is read, and quickly', () => {
    const long = `${'pstvencoded' + 'q'.repeat(200_000)} <bob@example.com>, =?UTF-8?Q?Ann?= <ann@example.com>`
    const started = performance.now()
    const list = structuredAddresses(long)
    expect(performance.now() - started).toBeLessThan(2000)
    expect(list.map((a) => a.address)).toEqual(['bob@example.com', 'ann@example.com'])
    expect(list[1].name).toBe('Ann')
  })

  test('nonsense in, nothing dangerous out', () => {
    expect(structuredAddresses('')).toEqual([])
    for (const junk of ['<<<>>>', '=?', '=?UTF-8?Q??=', '=?UTF-8?X?abc?= <a@example.com>', ',;:,']) {
      expect(() => structuredAddresses(junk)).not.toThrow()
    }
  })
})

describe('parseEml', () => {
  test('a message with an absurd address header still opens, with the people it names', async () => {
    const eml = simpleEml({
      subject: 'Still readable',
      to: `${'pstvencoded' + 'q'.repeat(40_000)} <bob@example.com>, ${'x'.repeat(50_000)}`,
    })
    const message = await parseEml(eml.slice().buffer, 'id')
    expect(message.subject).toBe('Still readable')
    expect(message.senderEmailAddress).toBe('alice@example.com')
    const recipients = (await message.getRecipients()) as unknown as { smtpAddress: string }[]
    expect(recipients[0].smtpAddress).toBe('bob@example.com')
  })

  test.each([
    '=?UTF-8?Q?Boss_<boss@company.example>?=, <attacker@evil.example>',
    '=?UTF-8?Q?boss@company.example?=, attacker@evil.example',
    '=?UTF-8?Q?IT_Support_<helpdesk@company.example>?= <attacker@evil.example>',
  ])('the sender of a message with From: %s is the real address', async (from) => {
    const message = await parseEml(simpleEml({ subject: 'x', from }).slice().buffer, 'id')
    expect(message.senderEmailAddress).toBe('attacker@evil.example')
  })

  test('a sender written entirely as one encoded word is still read', async () => {
    const message = await parseEml(
      simpleEml({ subject: 'x', from: '=?UTF-8?Q?Alice_Example_<alice@example.com>?=' }).slice().buffer,
      'id',
    )
    expect(message.senderEmailAddress).toBe('alice@example.com')
    expect(message.senderName).toBe('Alice Example')
  })

  test('bytes that are not a message are refused', async () => {
    await expect(parseEml(new TextEncoder().encode('just some text').buffer as ArrayBuffer, 'id')).rejects.toThrow(
      'not an RFC822 message',
    )
    await expect(parseEml(new ArrayBuffer(0), 'id')).rejects.toThrow('not an RFC822 message')
  })
})

