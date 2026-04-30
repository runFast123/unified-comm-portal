import { describe, it, expect } from 'vitest'
import {
  parseMentions,
  dedupeMentionUserIds,
  encodeMention,
  MENTION_REGEX,
} from '@/lib/mentions'

const UID_A = '11111111-1111-4111-8111-111111111111'
const UID_B = '22222222-2222-4222-8222-222222222222'

describe('parseMentions', () => {
  it('returns an empty array for empty / null input', () => {
    expect(parseMentions('')).toEqual([])
    expect(parseMentions(undefined as unknown as string)).toEqual([])
  })

  it('extracts a single mention', () => {
    const text = `Hey ${encodeMention(UID_A, 'Aman')} please look at this.`
    const ms = parseMentions(text)
    expect(ms).toHaveLength(1)
    expect(ms[0].userId).toBe(UID_A)
    expect(ms[0].displayName).toBe('Aman')
  })

  it('extracts multiple mentions in order', () => {
    const text = `${encodeMention(UID_A, 'Aman')} and ${encodeMention(UID_B, 'Beth')}`
    const ms = parseMentions(text)
    expect(ms.map((m) => m.userId)).toEqual([UID_A, UID_B])
    expect(ms.map((m) => m.displayName)).toEqual(['Aman', 'Beth'])
  })

  it('handles names with spaces and punctuation', () => {
    const text = `cc ${encodeMention(UID_A, 'Maria de la Cruz')}`
    const ms = parseMentions(text)
    expect(ms).toHaveLength(1)
    expect(ms[0].displayName).toBe('Maria de la Cruz')
  })

  it('ignores plain @username text without the bracket form', () => {
    const text = '@aman please ping the team'
    expect(parseMentions(text)).toEqual([])
  })

  it('rejects malformed UUIDs', () => {
    const text = '@[Aman](not-a-uuid)'
    expect(parseMentions(text)).toEqual([])
  })

  it('does not leak lastIndex state across calls', () => {
    const text = encodeMention(UID_A, 'Aman')
    expect(parseMentions(text)).toHaveLength(1)
    // A second call must not be affected by the first.
    expect(parseMentions(text)).toHaveLength(1)
  })
})

describe('dedupeMentionUserIds', () => {
  it('returns empty for no mentions', () => {
    expect(dedupeMentionUserIds([])).toEqual([])
  })

  it('preserves first-seen order and deduplicates', () => {
    const text = `${encodeMention(UID_B, 'Beth')} cc ${encodeMention(UID_A, 'Aman')} and ${encodeMention(UID_B, 'Beth')}`
    const ms = parseMentions(text)
    expect(dedupeMentionUserIds(ms)).toEqual([UID_B, UID_A])
  })
})

describe('encodeMention', () => {
  it('produces a token that round-trips through parseMentions', () => {
    const token = encodeMention(UID_A, 'Aman')
    const ms = parseMentions(`hi ${token}!`)
    expect(ms).toHaveLength(1)
    expect(ms[0].userId).toBe(UID_A)
    expect(ms[0].displayName).toBe('Aman')
  })

  it('strips closing brackets and newlines from the display name', () => {
    const token = encodeMention(UID_A, 'Bad]Name\nNewline')
    expect(token).toBe(`@[BadNameNewline](${UID_A})`)
    const ms = parseMentions(token)
    expect(ms).toHaveLength(1)
    expect(ms[0].displayName).toBe('BadNameNewline')
  })

  it('falls back to "user" when display name is empty after sanitization', () => {
    const token = encodeMention(UID_A, ']]]]')
    expect(token).toBe(`@[user](${UID_A})`)
  })
})

describe('MENTION_REGEX', () => {
  it('is global and reusable from a fresh RegExp constructed from .source', () => {
    const text = `${encodeMention(UID_A, 'A')} ${encodeMention(UID_B, 'B')}`
    const re = new RegExp(MENTION_REGEX.source, 'g')
    const matches = text.match(re)
    expect(matches).toHaveLength(2)
  })
})
