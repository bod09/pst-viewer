import { beforeAll, describe, expect, test } from 'vitest'
import type { PstWorkerApi } from '../../src/worker/pst.worker'
import { PNG, base64, crlf, simpleEml } from '../support/fixtures.mjs'
import { fileOf } from '../support/files'
import { loadWorker } from '../support/worker'

let api: PstWorkerApi

/** Subjects of the messages a query finds, sorted so order does not matter. */
const find = async (query: string) => (await api.search(query)).map((h) => h.subject).sort()

const withAttachment = crlf([
  'From: Dave Inner <dave@example.com>',
  'To: Alice Example <alice@example.com>',
  'Subject: Budget spreadsheet',
  'Date: Fri, 15 Mar 2024 09:00:00 +0000',
  'MIME-Version: 1.0',
  'Content-Type: multipart/mixed; boundary="B"',
  '',
  '--B',
  'Content-Type: text/plain',
  '',
  'Numbers attached.',
  '--B',
  'Content-Type: image/png; name="forecast-chart.png"',
  'Content-Disposition: attachment; filename="forecast-chart.png"',
  'Content-Transfer-Encoding: base64',
  '',
  base64(PNG),
  '--B--',
  '',
])

beforeAll(async () => {
  api = await loadWorker()
  // Dates are given with the test timezone's own offset (+09:00, see
  // vitest.config.ts), so "the 12th" below means the 12th where the reader is.
  await api.openMsgSource('archive', [
    fileOf(
      '1.eml',
      simpleEml({
        subject: 'Quarterly zebra report',
        from: 'Alice Example <alice@example.com>',
        to: 'Bob Tester <bob@example.com>',
        date: 'Tue, 12 Mar 2024 10:15:00 +0900',
        body: 'The zebra migration figures. The quick brown fox jumps over the lazy dog. Invoice 48213.',
      }),
    ),
    fileOf(
      '2.eml',
      simpleEml({
        subject: 'Lunch on Thursday',
        from: 'Bob Tester <bob@example.com>',
        to: 'Alice Example <alice@example.com>',
        cc: 'Carol Sender <carol@example.com>',
        date: 'Wed, 13 Mar 2024 00:30:00 +0900',
        body: 'Shall we try the brown fox cafe? The dog can come. Invoice 48219 can wait.',
        headers: ['Importance: high'],
      }),
    ),
    fileOf(
      '3.eml',
      simpleEml({
        subject: 'Re: Lunch on Thursday',
        from: 'Carol Sender <carol@example.com>',
        to: 'Bob Tester <bob@example.com>',
        date: 'Thu, 14 Mar 2024 23:59:00 +0900',
        body: 'Yes. See you there.',
        headers: ['X-Priority: 5'],
      }),
    ),
    fileOf('4.eml', withAttachment),
  ])
  await api.setSourceLabel('archive', 'Work Archive')
  await api.indexSource('archive')

  await api.openMsgSource('personal', [
    fileOf(
      '5.eml',
      simpleEml({
        subject: 'Holiday zebra photos',
        from: 'Eve Friend <eve@example.org>',
        to: 'Alice Example <alice@example.com>',
        date: 'Sat, 16 Mar 2024 12:00:00 +0900',
        body: 'Photos from the safari.',
      }),
    ),
  ])
  await api.setSourceLabel('personal', 'Personal')
  await api.indexSource('personal')
})

describe('words', () => {
  test('find messages by their subject, body, people and attachment names', async () => {
    expect(await find('migration')).toEqual(['Quarterly zebra report'])
    expect(await find('thursday')).toEqual(['Lunch on Thursday', 'Re: Lunch on Thursday'])
    expect(await find('safari')).toEqual(['Holiday zebra photos'])
    expect(await find('forecast')).toEqual(['Budget spreadsheet'])
    expect(await find('eve')).toEqual(['Holiday zebra photos'])
  })

  test('every word must match', async () => {
    expect(await find('zebra')).toEqual(['Holiday zebra photos', 'Quarterly zebra report'])
    expect(await find('zebra photos')).toEqual(['Holiday zebra photos'])
    expect(await find('zebra thursday')).toEqual([])
  })

  test('the start of a word and a small typo still match', async () => {
    expect(await find('migrat')).toEqual(['Quarterly zebra report'])
    expect(await find('migartion')).toEqual(['Quarterly zebra report'])
  })

  test('numbers must match exactly: a near miss is a different invoice', async () => {
    expect(await find('48213')).toEqual(['Quarterly zebra report'])
    expect(await find('48219')).toEqual(['Lunch on Thursday'])
    expect(await find('48214')).toEqual([])
  })

  test('nothing typed finds nothing', async () => {
    expect(await api.search('')).toEqual([])
    expect(await api.search('   ')).toEqual([])
  })
})

describe('quoted phrases', () => {
  test('match only where the words stand together, in that order', async () => {
    // Both messages contain "brown", "fox" and "dog"; only one has this run.
    expect(await find('brown fox')).toEqual(['Lunch on Thursday', 'Quarterly zebra report'])
    expect(await find('"fox jumps over"')).toEqual(['Quarterly zebra report'])
    expect(await find('"brown fox cafe"')).toEqual(['Lunch on Thursday'])
    expect(await find('"fox brown"')).toEqual([])
  })

  test('can be combined with words and filters', async () => {
    expect(await find('"brown fox" cafe')).toEqual(['Lunch on Thursday'])
    expect(await find('"brown fox" from:alice')).toEqual(['Quarterly zebra report'])
  })

  test('match whole words exactly: no word starts, no typos', async () => {
    expect(await find('"fox jumps"')).toEqual(['Quarterly zebra report'])
    expect(await find('"fox jump"')).toEqual([])
    expect(await find('"fox jmups"')).toEqual([])
  })
})

describe('filters', () => {
  test('from: and to: match a name or an address', async () => {
    expect(await find('from:alice')).toEqual(['Quarterly zebra report'])
    expect(await find('from:bob@example.com')).toEqual(['Lunch on Thursday'])
    expect(await find('to:alice')).toEqual(['Budget spreadsheet', 'Holiday zebra photos', 'Lunch on Thursday'])
    expect(await find('from:"Carol Sender"')).toEqual(['Re: Lunch on Thursday'])
    expect(await find('FROM:ALICE')).toEqual(['Quarterly zebra report'])
  })

  test('person: matches either direction', async () => {
    expect(await find('person:carol')).toEqual(['Lunch on Thursday', 'Re: Lunch on Thursday'])
    expect(await find('person:eve')).toEqual(['Holiday zebra photos'])
  })

  test('subject: looks only at the subject', async () => {
    expect(await find('subject:zebra')).toEqual(['Holiday zebra photos', 'Quarterly zebra report'])
    expect(await find('subject:migration')).toEqual([])
  })

  test('has:attachment', async () => {
    expect(await find('has:attachment')).toEqual(['Budget spreadsheet'])
    expect(await find('has:attachments zebra')).toEqual([])
  })

  test('is: selects by importance', async () => {
    expect(await find('is:high')).toEqual(['Lunch on Thursday'])
    expect(await find('is:low')).toEqual(['Re: Lunch on Thursday'])
  })

  test('an is: value nobody knows finds nothing, rather than everything', async () => {
    expect(await find('is:nonsense')).toEqual([])
    expect(await find('zebra is:nonsense')).toEqual([])
  })

  test('mailbox: limits the search to mailboxes by their label; several widen it', async () => {
    expect(await find('zebra mailbox:personal')).toEqual(['Holiday zebra photos'])
    expect(await find('zebra mailbox:"work archive"')).toEqual(['Quarterly zebra report'])
    expect(await find('zebra mailbox:personal mailbox:work')).toEqual(['Holiday zebra photos', 'Quarterly zebra report'])
    expect(await find('zebra mailbox:elsewhere')).toEqual([])
  })

  test('folder: limits the search to folders by name', async () => {
    expect(await find('zebra folder:messages')).toEqual(['Holiday zebra photos', 'Quarterly zebra report'])
    expect(await find('zebra folder:inbox')).toEqual([])
  })

  test('filters alone list every message that passes, newest first', async () => {
    const hits = await api.search('mailbox:work')
    expect(hits.map((h) => h.subject)).toEqual([
      'Budget spreadsheet',
      'Re: Lunch on Thursday',
      'Lunch on Thursday',
      'Quarterly zebra report',
    ])
  })

  test('a filter with nothing after it is an ordinary word', async () => {
    // "from" is in one body: "Photos from the safari".
    expect(await find('from:')).toEqual(['Holiday zebra photos'])
  })
})

describe('dates', () => {
  // The messages were sent on the 12th at 10:15, the 13th at 00:30, the 14th
  // at 23:59, the 15th and the 16th, in the reader's own timezone.
  test('after: includes that day from its first minute, where the reader is', async () => {
    expect(await find('mailbox:work after:2024-03-13')).toEqual([
      'Budget spreadsheet',
      'Lunch on Thursday',
      'Re: Lunch on Thursday',
    ])
  })

  test('before: stops at the start of that day', async () => {
    expect(await find('mailbox:work before:2024-03-13')).toEqual(['Quarterly zebra report'])
    expect(await find('mailbox:work before:2024-03-15')).toEqual([
      'Lunch on Thursday',
      'Quarterly zebra report',
      'Re: Lunch on Thursday',
    ])
  })

  test('together they make a range', async () => {
    expect(await find('after:2024-03-13 before:2024-03-14')).toEqual(['Lunch on Thursday'])
    expect(await find('after:2024-03-14 before:2024-03-15')).toEqual(['Re: Lunch on Thursday'])
    expect(await find('after:2024-03-20')).toEqual([])
  })

  test('a date that cannot be read is ignored, not treated as a match for nothing', async () => {
    expect(await find('zebra after:someday')).toEqual(['Holiday zebra photos', 'Quarterly zebra report'])
  })
})

describe('a result', () => {
  test('says where the message is, so it can be opened', async () => {
    const [hit] = await api.search('migration')
    expect(hit).toMatchObject({
      sourceId: 'archive',
      folderId: 'msgfolder',
      subject: 'Quarterly zebra report',
      from: 'Alice Example alice@example.com',
      hasAttachments: false,
    })
    const content = await api.getMessageContent(hit.sourceId, hit.messageId)
    expect(content?.subject).toBe('Quarterly zebra report')
  })
})

describe('people suggestions', () => {
  test('offer the people in the open mailboxes that match what was typed', async () => {
    const all = await api.suggestPeople('', 20)
    expect(all.some((p) => p.includes('alice@example.com'))).toBe(true)
    const carol = await api.suggestPeople('caro')
    expect(carol).toHaveLength(1)
    expect(carol[0]).toContain('carol@example.com')
    expect(await api.suggestPeople('nobody-by-this-name')).toEqual([])
  })
})
