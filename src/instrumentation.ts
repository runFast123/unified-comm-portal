export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    await import('../sentry.server.config')
  } else if (process.env.NEXT_RUNTIME === 'edge') {
    await import('../sentry.edge.config')
  }
}

// Headers we're willing to forward to Sentry as extra context. Keep this an
// allowlist, not a blocklist — `authorization`, `cookie`, `x-webhook-secret`
// etc. must NEVER end up in an error report.
const SAFE_HEADER_ALLOWLIST = new Set([
  'user-agent',
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-proto',
  'x-real-ip',
  'referer',
  'accept-language',
  'content-type',
  'content-length',
])

function pickSafeHeaders(req: Request): Record<string, string> {
  const out: Record<string, string> = {}
  try {
    req.headers.forEach((value, key) => {
      if (SAFE_HEADER_ALLOWLIST.has(key.toLowerCase())) {
        // Cap individual header value at 256 chars so we don't blow up the
        // Sentry payload on a 4 KB User-Agent.
        out[key] = value.length > 256 ? `${value.slice(0, 256)}…` : value
      }
    })
  } catch {
    // Forwarding context is best-effort; failure is fine.
  }
  return out
}

export async function onRequestError(err: unknown, request: Request) {
  const Sentry = await import('@sentry/nextjs')

  let route = 'unknown'
  let method = 'unknown'
  try {
    route = new URL(request.url).pathname
  } catch { /* keep default */ }
  try {
    method = request.method || 'unknown'
  } catch { /* keep default */ }

  const requestId = request.headers.get('x-request-id') || undefined
  const safeHeaders = pickSafeHeaders(request)

  const tags: Record<string, string> = { route, method }
  if (requestId) tags.request_id = requestId

  Sentry.captureException(err, {
    tags,
    extra: {
      headers: safeHeaders,
    },
  })
}
