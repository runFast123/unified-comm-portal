import { randomUUID } from 'crypto'
import { headers } from 'next/headers'

const HEADER = 'x-request-id'

/**
 * Tight regex for accepted incoming request ids. Anything outside [a-zA-Z0-9_-]
 * (including whitespace, control chars, slashes, angle brackets, quotes, NUL,
 * etc.) is rejected — that way an attacker can't smuggle XSS / log-injection
 * payloads through the header. Length capped at 128 chars so a 4 KB header
 * doesn't blow up Sentry tags or log lines.
 */
const ID_PATTERN = /^[a-zA-Z0-9_-]{8,128}$/

/**
 * Get the current request id. Reads `x-request-id` from the incoming request
 * if present and well-formed; otherwise mints a fresh UUID. The middleware
 * (`src/middleware.ts`) sets this header on every request that goes through
 * the matcher, so most code paths reuse the existing id rather than minting.
 *
 * Safe to call outside a request scope (background jobs, polled cron) — it
 * just falls back to a fresh UUID.
 */
export async function getRequestId(): Promise<string> {
  try {
    const h = await headers()
    const incoming = h.get(HEADER)
    if (incoming && ID_PATTERN.test(incoming)) return incoming
  } catch {
    // headers() throws when invoked outside a request context. Fine — we just
    // mint a new id below.
  }
  return randomUUID()
}

/**
 * Validate an externally-supplied id (e.g. from a fetch caller) against the
 * same pattern. Used by middleware to decide whether to keep an upstream id
 * or replace it with a freshly-minted one.
 */
export function isValidRequestId(id: string | null | undefined): id is string {
  return !!id && ID_PATTERN.test(id)
}

/**
 * Mint a fresh request id without touching the request scope. Useful for
 * pollers that fan one cron run out into many per-message webhook calls —
 * each individual ingestion gets its own id so it can be traced end-to-end.
 */
export function mintRequestId(): string {
  return randomUUID()
}

export const REQUEST_ID_HEADER = HEADER
