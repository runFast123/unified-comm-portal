import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { signState, verifyState, type OAuthStatePayload } from '@/lib/oauth-state'

const ORIGINAL_SECRET = process.env.WEBHOOK_SECRET

describe('oauth-state sign/verify', () => {
  beforeAll(() => {
    process.env.WEBHOOK_SECRET = 'test-webhook-secret-for-oauth-state-tests'
  })

  afterAll(() => {
    if (ORIGINAL_SECRET === undefined) delete process.env.WEBHOOK_SECRET
    else process.env.WEBHOOK_SECRET = ORIGINAL_SECRET
  })

  function payload(): OAuthStatePayload {
    return {
      account_id: 'X',
      nonce: 'Y',
      expires_at: Date.now() + 60_000,
    }
  }

  it('signState returns a string with a "." separator between encoded body and HMAC', () => {
    const signed = signState(payload())
    expect(typeof signed).toBe('string')
    expect(signed).toContain('.')
    const dot = signed.lastIndexOf('.')
    expect(dot).toBeGreaterThan(0)
    const body = signed.slice(0, dot)
    const mac = signed.slice(dot + 1)
    expect(body.length).toBeGreaterThan(0)
    expect(mac.length).toBeGreaterThan(0)
    // HMAC-SHA256 hex is 64 chars
    expect(mac).toMatch(/^[0-9a-f]{64}$/)
  })

  it('verifyState of a freshly signed payload returns the original payload', () => {
    const original = payload()
    const signed = signState(original)
    const parsed = verifyState(signed)
    expect(parsed).not.toBeNull()
    expect(parsed!.account_id).toBe(original.account_id)
    expect(parsed!.nonce).toBe(original.nonce)
    expect(parsed!.expires_at).toBe(original.expires_at)
  })

  it('verifyState of a tampered base64 body returns null', () => {
    const signed = signState(payload())
    const dot = signed.lastIndexOf('.')
    const body = signed.slice(0, dot)
    const mac = signed.slice(dot + 1)
    // Flip one character of the encoded body — MAC will no longer match.
    const flipped = (body[0] === 'A' ? 'B' : 'A') + body.slice(1)
    expect(verifyState(`${flipped}.${mac}`)).toBeNull()
  })

  it('verifyState of a string with a bad HMAC returns null', () => {
    const signed = signState(payload())
    const dot = signed.lastIndexOf('.')
    const body = signed.slice(0, dot)
    // Replace HMAC with a different (but well-formed) hex string.
    const fakeMac = 'a'.repeat(64)
    expect(verifyState(`${body}.${fakeMac}`)).toBeNull()
  })

  it('verifyState of null/undefined/empty input returns null', () => {
    expect(verifyState(null)).toBeNull()
    expect(verifyState(undefined)).toBeNull()
    expect(verifyState('')).toBeNull()
  })

  it('verifyState of a string with no separator returns null', () => {
    expect(verifyState('garbage-no-dot')).toBeNull()
  })
})
