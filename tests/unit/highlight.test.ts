import { describe, expect, test } from 'vitest'
import { escapeRegExp, queryTerms, termsRegExp } from '../../src/lib/highlight'

describe('queryTerms', () => {
  test('free words are highlighted as typed, lower-cased and once each', () => {
    expect(queryTerms('Zebra report zebra')).toEqual(['zebra', 'report'])
  })

  test('a quoted phrase is one term', () => {
    expect(queryTerms('"quarterly zebra" figures')).toEqual(['quarterly zebra', 'figures'])
  })

  test('filters narrow the search and are not text to highlight', () => {
    expect(
      queryTerms(
        'from:alice to:"Bob Tester" subject:zebra person:carol has:attachment is:unread ' +
          'before:2024-03-13 after:2024-03-01 mailbox:archive folder:"Sent Items" pomegranate',
      ),
    ).toEqual(['pomegranate'])
  })

  test('a colon that is not a filter is ordinary text', () => {
    expect(queryTerms('re:invoice http://example.com')).toEqual(['re:invoice', 'http://example.com'])
  })

  test('single characters are too short to highlight', () => {
    expect(queryTerms('a "b" cd')).toEqual(['cd'])
  })

  test('an empty query has no terms', () => {
    expect(queryTerms('')).toEqual([])
    expect(queryTerms('   ""  ')).toEqual([])
  })
})

describe('termsRegExp', () => {
  test('matches any term, whatever its case', () => {
    const re = termsRegExp(['zebra', 'quarterly report'])
    expect('The Quarterly Report on ZEBRAS'.match(re!)).toEqual(['Quarterly Report', 'ZEBRA'])
  })

  test('takes characters special to a pattern literally', () => {
    const re = termsRegExp(['c++ (draft)', 'a.b', '[x]', '$5'])
    expect('C++ (draft) aXb a.b [x] $5'.match(re!)).toEqual(['C++ (draft)', 'a.b', '[x]', '$5'])
    expect(escapeRegExp('.*+?^${}()|[]\\')).toBe('\\.\\*\\+\\?\\^\\$\\{\\}\\(\\)\\|\\[\\]\\\\')
  })

  test('no terms, no pattern', () => {
    expect(termsRegExp([])).toBeNull()
  })
})
