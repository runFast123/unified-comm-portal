import { createHmac, timingSafeEqual } from 'crypto'

/**
 * Signed OAuth state cookie helpers.
 *
 * The state cookie binds an OAuth round-trip to an account_id. If it's
 * unsigned, an attacker who can plant a cookie (e.g. via CSRF against a
 * misconfigured parent, subdomain takeover, or leaked cookie) could
 * redirect the callback into writing tokens against an account of their
 * choosing. HMAC signing with the shared WEBHOOK_SECRET prevents that —
 * forgeries can't produce a valid MAC without the key.
 *
 * Wire format: base64url(json) + '.' + hex(hmacSha256)
 */

export interface OAuthStatePayload {
  account_id: string
  nonce: string
  expires_at: number
}

function getKey(): Buffer {
  const secret = process.env.WEBHOOK_SECRET
  if (!secret) {
    throw new Error('WEBHOOK_SECRET is not configured — cannot sign OAuth state cookie')
  }
  return Buffer.from(secret, 'utf8')
}

/**
 * Serialize and HMAC-sign the given payload. The returned string is
 * cookie-safe (base64 + '.' + hex).
 */
export function signState(payload: OAuthStatePayload): string {
  const json = JSON.stringify(payload)
  const encoded = Buffer.from(json, 'utf8').toString('base64')
  const mac = createHmac('sha256', getKey()).update(encoded).digest('hex')
  return `${encoded}.${mac}`
}

/**
 * Verify and parse a signed state cookie. Returns the payload on success
 * or null on any failure (malformed, bad MAC, JSON parse error, missing
 * fields). TTL is NOT enforced here — callers decide what to do with an
 * expired-but-valid payload (usually: reject with state_expired).
 */
export function verifyState(signed: string | undefined | null): OAuthStatePayload | null {
  if (!signed) return null
  const dot = signed.lastIndexOf('.')
  if (dot < 0) return null
  const encoded = signed.slice(0, dot)
  const mac = signed.slice(dot + 1)
  if (!encoded || !mac) return null

  let expectedMac: string
  try {
    expectedMac = createHmac('sha256', getKey()).update(encoded).digest('hex')
  } catch {
    return null
  }

  // Constant-time compare. timingSafeEqual throws on length mismatch, so
  // short-circuit that case first.
  const a = Buffer.from(mac, 'hex')
  const b = Buffer.from(expectedMac, 'hex')
  if (a.length === 0 || a.length !== b.length) return null
  try {
    if (!timingSafeEqual(a, b)) return null
  } catch {
    return null
  }

  try {
    const parsed = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8')) as OAuthStatePayload
    if (
      !parsed ||
      typeof parsed.account_id !== 'string' ||
      typeof parsed.nonce !== 'string' ||
      typeof parsed.expires_at !== 'number'
    ) {
      return null
    }
    return parsed
  } catch {
    return null
  }
}
