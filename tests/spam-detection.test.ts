import { describe, it, expect } from 'vitest'
import { detectSpam } from '@/lib/spam-detection'

describe('spam-detection (baseline)', () => {
  it('legitimate sender + neutral subject + neutral body is NOT spam', () => {
    const r = detectSpam('user@example.com', 'Hello', 'normal text')
    expect(r.isSpam).toBe(false)
    expect(r.reason).toBeNull()
  })

  it('noreply@ sender is flagged as spam', () => {
    const r = detectSpam('noreply@bank.com', 'Statement ready', 'see attached')
    expect(r.isSpam).toBe(true)
  })

  it('subject containing "unsubscribe" is flagged as spam', () => {
    const r = detectSpam('user@example.com', 'Unsubscribe link below', '...')
    expect(r.isSpam).toBe(true)
  })

  it('enabled=false returns isSpam=false regardless of inputs', () => {
    const r = detectSpam(
      'noreply@spammer.com',
      'Unsubscribe newsletter advertisement',
      'click unsubscribe view in browser email preferences opt out',
      { enabled: false },
    )
    expect(r).toEqual({ isSpam: false, reason: null })
  })

  it('allowlist substring match short-circuits even on a noreply sender', () => {
    const r = detectSpam(
      'notifications@mybank.com',
      'Promotional',
      '...',
      { allowlist: ['mybank.com'] },
    )
    expect(r).toEqual({ isSpam: false, reason: null })
  })

  it('allowlist matching is case-insensitive', () => {
    const r = detectSpam(
      'NOREPLY@MYBANK.COM',
      'Newsletter promo',
      'body',
      { allowlist: ['MyBank.com'] },
    )
    expect(r).toEqual({ isSpam: false, reason: null })
  })

  it('null sender does not crash', () => {
    const r = detectSpam(null, 'Hello', 'normal text')
    expect(r.isSpam).toBe(false)
  })

  it('empty-string sender does not crash', () => {
    const r = detectSpam('', null, '')
    expect(r).toEqual({ isSpam: false, reason: null })
  })
})
