import { detectSpam } from '@/lib/spam-detection'

describe('spam-detection', () => {
  it('returns {isSpam:false, reason:null} when enabled=false even for obvious spam', () => {
    const r = detectSpam(
      'noreply@spam.example',
      'Unsubscribe from our newsletter',
      'click here to unsubscribe or view in browser',
      { enabled: false },
    )
    expect(r).toEqual({ isSpam: false, reason: null })
  })

  it('allowlist substring match (case-insensitive) overrides the hardest spam signal', () => {
    const r = detectSpam(
      'NOREPLY@MYBANK.COM',
      'Security notice',
      'any body',
      { allowlist: ['mybank.com'] },
    )
    expect(r).toEqual({ isSpam: false, reason: null })
  })

  it('allowlist entry that matches full sender still overrides noreply prefix', () => {
    const r = detectSpam(
      'noreply@mybank.com',
      'Transaction alert',
      'body',
      { allowlist: ['noreply@mybank.com'] },
    )
    expect(r).toEqual({ isSpam: false, reason: null })
  })

  it('subject "Webinar ..." triggers newsletter classification', () => {
    const r = detectSpam(
      'events@acme.com',
      'Webinar: scaling Postgres',
      'body text',
    )
    expect(r.isSpam).toBe(true)
    expect(r.reason).toBe('newsletter')
  })

  it('body with >=2 spam signals is flagged as newsletter', () => {
    // Sender + subject are clean — only the body should trip it.
    const body = 'hello friend, email preferences are here and view in browser link at top'
    const r = detectSpam(
      'person@example.com',
      'Quick hello',
      body,
    )
    expect(r.isSpam).toBe(true)
    expect(r.reason).toBe('newsletter')
  })

  it('body with only ONE spam signal is NOT flagged', () => {
    const r = detectSpam(
      'person@example.com',
      'Quick hello',
      'there is an unsubscribe link below but nothing else indicative',
    )
    expect(r.isSpam).toBe(false)
  })

  it('legitimate support email passes through cleanly', () => {
    const r = detectSpam(
      'support@acme.com',
      'Invoice question',
      'Hi team, can you clarify line 3 on invoice 4521? Thanks.',
    )
    expect(r).toEqual({ isSpam: false, reason: null })
  })

  it('empty inputs do not crash and are not flagged', () => {
    const r = detectSpam(null, null, '')
    expect(r).toEqual({ isSpam: false, reason: null })
  })

  it('noreply@ prefix with no allowlist is flagged', () => {
    const r = detectSpam('noreply@example.org', 'Receipt', 'thanks')
    expect(r.isSpam).toBe(true)
    expect(r.reason).toBe('automated_notification')
  })

  it('mailchimp domain is flagged as newsletter', () => {
    const r = detectSpam('campaign@sender.mailchimp.com', 'Hello', 'hi')
    expect(r.isSpam).toBe(true)
    expect(r.reason).toBe('newsletter')
  })
})
