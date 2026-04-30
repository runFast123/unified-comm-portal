import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'

// `validateWebhookSecret` does not touch Supabase, but `api-helpers.ts` imports
// modules that DO at top level. Stub them so importing the file is safe in a
// pure-Node test env.
vi.mock('@/lib/supabase-server', () => ({
  createServiceRoleClient: vi.fn(),
}))
vi.mock('@/lib/rate-limiter', () => ({
  checkRateLimit: vi.fn(),
}))

import { validateWebhookSecret } from '@/lib/api-helpers'

const ORIGINAL_SECRET = process.env.WEBHOOK_SECRET

function makeRequest(headerValue?: string): Request {
  const headers: Record<string, string> = {}
  if (headerValue !== undefined) headers['x-webhook-secret'] = headerValue
  return new Request('http://localhost', { headers })
}

describe('validateWebhookSecret', () => {
  beforeEach(() => {
    delete process.env.WEBHOOK_SECRET
  })

  afterAll(() => {
    if (ORIGINAL_SECRET === undefined) delete process.env.WEBHOOK_SECRET
    else process.env.WEBHOOK_SECRET = ORIGINAL_SECRET
  })

  it('returns false when WEBHOOK_SECRET env var is missing', () => {
    const req = makeRequest('any-value')
    expect(validateWebhookSecret(req)).toBe(false)
  })

  it('returns false when the x-webhook-secret header is missing', () => {
    process.env.WEBHOOK_SECRET = 'expected-secret'
    const req = makeRequest(undefined)
    expect(validateWebhookSecret(req)).toBe(false)
  })

  it('returns false on length mismatch (timing-safe comparator requires equal lengths)', () => {
    process.env.WEBHOOK_SECRET = 'expected-secret-long'
    const req = makeRequest('short')
    expect(validateWebhookSecret(req)).toBe(false)
  })

  it('returns true on exact match', () => {
    process.env.WEBHOOK_SECRET = 'matching-secret-12345'
    const req = makeRequest('matching-secret-12345')
    expect(validateWebhookSecret(req)).toBe(true)
  })

  it('returns false on a wrong value of equal length', () => {
    process.env.WEBHOOK_SECRET = 'AAAAAAAAAAAAAAAAAAAA'
    const req = makeRequest('BBBBBBBBBBBBBBBBBBBB')
    expect(validateWebhookSecret(req)).toBe(false)
  })
})
