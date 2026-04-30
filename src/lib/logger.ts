export type LogLevel = 'info' | 'warn' | 'error' | 'debug'
export type LogCategory = 'webhook' | 'ai' | 'auth' | 'system' | 'notification' | 'export'

interface LogEntry {
  level: LogLevel
  category: LogCategory
  action: string
  message: string
  metadata?: Record<string, unknown>
  user_id?: string | null
  account_id?: string | null
}

// ─── Secret-stripping for log payloads ───────────────────────────────
// `details` may legitimately contain provider responses, tokens, or partial
// configs (especially in dev paths). We never want these in audit_log JSON,
// stdout, or Sentry. Match by KEY name (case-insensitive) so renaming a value
// doesn't accidentally re-expose it.
const SECRET_KEY_NAMES = new Set([
  'password',
  'secret',
  'token',
  'api_key',
  'apikey',
  'client_secret',
  'access_token',
  'refresh_token',
  'authorization',
  'cookie',
  'session',
  'private_key',
])

const STRUCTURED_LIFT_KEYS = ['request_id', 'account_id', 'user_id', 'duration_ms'] as const

/**
 * Recursively redact any object whose key matches a known secret name.
 * Returns a new value — never mutates the input. Caps recursion at depth 6
 * to avoid blowing up on a circular structure (which would be an upstream
 * bug, but the logger should never be the thing that crashes the process).
 */
function redactSecrets(value: unknown, depth = 0): unknown {
  if (depth > 6 || value === null || value === undefined) return value
  if (Array.isArray(value)) return value.map((v) => redactSecrets(v, depth + 1))
  if (typeof value !== 'object') return value
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (SECRET_KEY_NAMES.has(k.toLowerCase())) {
      out[k] = '[REDACTED]'
    } else {
      out[k] = redactSecrets(v, depth + 1)
    }
  }
  return out
}

/**
 * Lift well-known correlation fields (request_id, account_id, user_id,
 * duration_ms) out of `details` so they show up as top-level structured
 * fields in JSON logs and as Sentry tags. Returns:
 *   { lifted: { request_id?, account_id?, user_id?, duration_ms? },
 *     remaining: <details with the lifted keys removed> }
 */
function liftStructuredFields(details: Record<string, unknown> | undefined): {
  lifted: Partial<Record<(typeof STRUCTURED_LIFT_KEYS)[number], unknown>>
  remaining: Record<string, unknown> | undefined
} {
  if (!details) return { lifted: {}, remaining: undefined }
  const lifted: Record<string, unknown> = {}
  const remaining: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(details)) {
    if ((STRUCTURED_LIFT_KEYS as readonly string[]).includes(k) && v !== undefined && v !== null) {
      lifted[k] = v
    } else {
      remaining[k] = v
    }
  }
  return {
    lifted: lifted as Partial<Record<(typeof STRUCTURED_LIFT_KEYS)[number], unknown>>,
    remaining: Object.keys(remaining).length > 0 ? remaining : undefined,
  }
}

/**
 * Print to console in the configured format.
 *   LOG_FORMAT=json → single-line JSON suitable for Vercel/Datadog/Loki
 *                     ingest. Includes a top-level `ts` ISO timestamp.
 *   anything else  → human-friendly: [hh:mm:ss] [level] [category/event] msg details {ids}
 */
function emitToConsole(
  level: LogLevel,
  category: LogCategory,
  action: string,
  message: string,
  remaining: Record<string, unknown> | undefined,
  lifted: Record<string, unknown>
): void {
  if (process.env.LOG_FORMAT === 'json') {
    const payload: Record<string, unknown> = {
      ts: new Date().toISOString(),
      level,
      category,
      event: action,
      message,
      ...lifted,
    }
    if (remaining) payload.details = remaining
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(payload))
    return
  }

  // Human format
  const ts = new Date().toISOString().slice(11, 19) // HH:MM:SS
  const idsParts = Object.entries(lifted).map(([k, v]) => `${k}=${String(v)}`)
  const idsStr = idsParts.length > 0 ? ` {${idsParts.join(', ')}}` : ''
  const detailsStr = remaining ? ` ${JSON.stringify(remaining)}` : ''
  const line = `[${ts}] [${level}] [${category}/${action}] ${message}${detailsStr}${idsStr}`
  if (level === 'error') console.error(line)
  else if (level === 'warn') console.warn(line)
  // eslint-disable-next-line no-console
  else console.log(line)
}

/**
 * Structured logger that:
 *   1. Emits to console (JSON or friendly per LOG_FORMAT)
 *   2. Writes to audit_log table via REST (non-blocking, errors swallowed)
 *   3. Forwards warn+error to Sentry with category/event/request_id tags
 *
 * Pass correlation IDs (request_id, account_id, user_id, duration_ms) inside
 * `metadata` — they get auto-extracted to top-level structured fields and
 * Sentry tags. Secret-named keys (password, token, api_key, …) anywhere in
 * `metadata` are replaced with [REDACTED] before serialization.
 */
export async function log(entry: LogEntry): Promise<void> {
  // Strip secrets first, THEN lift correlation fields. Order matters so a
  // request_id named field can't be accidentally redacted.
  const safeMetadata = entry.metadata
    ? (redactSecrets(entry.metadata) as Record<string, unknown>)
    : undefined
  const { lifted, remaining } = liftStructuredFields(safeMetadata)

  // 1. Console — always.
  try {
    emitToConsole(
      entry.level,
      entry.category,
      entry.action,
      entry.message,
      remaining,
      lifted as Record<string, unknown>
    )
  } catch {
    // never let formatting errors crash the caller
  }

  // 2. Persist to audit_log via REST. Stays as a plain JSON string for
  //    backward compat with existing log readers.
  try {
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
    if (supabaseUrl && serviceKey) {
      await fetch(`${supabaseUrl}/rest/v1/audit_log`, {
        method: 'POST',
        headers: {
          'apikey': serviceKey,
          'Authorization': `Bearer ${serviceKey}`,
          'Content-Type': 'application/json',
          'Prefer': 'return=minimal',
        },
        body: JSON.stringify({
          action: `[${entry.level.toUpperCase()}] ${entry.category}:${entry.action}`,
          details: JSON.stringify({
            message: entry.message,
            level: entry.level,
            category: entry.category,
            ...lifted,
            ...(remaining ?? {}),
          }),
          user_id: entry.user_id || (typeof lifted.user_id === 'string' ? lifted.user_id : null),
          account_id: entry.account_id || (typeof lifted.account_id === 'string' ? lifted.account_id : null),
          created_at: new Date().toISOString(),
        }),
      })
    }
  } catch {
    // Never let logging errors affect the main flow
  }

  // 3. Forward warn+error to Sentry. Lift correlation IDs into tags so the
  //    Sentry UI can filter by request_id / account_id / user_id directly.
  if ((entry.level === 'error' || entry.level === 'warn') && process.env.SENTRY_DSN) {
    try {
      const Sentry = await import('@sentry/nextjs')
      const tags: Record<string, string> = { category: entry.category, event: entry.action }
      if (typeof lifted.request_id === 'string') tags.request_id = lifted.request_id
      if (typeof lifted.account_id === 'string') tags.account_id = lifted.account_id
      if (typeof lifted.user_id === 'string') tags.user_id = lifted.user_id

      Sentry.captureMessage(`[${entry.category}] ${entry.action}: ${entry.message ?? ''}`, {
        level: entry.level === 'error' ? 'error' : 'warning',
        tags,
        extra: remaining ?? undefined,
      })
    } catch {
      // Never let Sentry forwarding errors affect the main flow
    }
  }
}

// Convenience helpers — same call signature as before. Pass correlation IDs
// inside `metadata` (e.g. { request_id, account_id, user_id, duration_ms })
// and they'll get lifted to structured fields + Sentry tags automatically.
export const logInfo = (
  category: LogCategory,
  action: string,
  message: string,
  metadata?: Record<string, unknown>
) => log({ level: 'info', category, action, message, metadata })

export const logWarn = (
  category: LogCategory,
  action: string,
  message: string,
  metadata?: Record<string, unknown>
) => log({ level: 'warn', category, action, message, metadata })

export const logError = (
  category: LogCategory,
  action: string,
  message: string,
  metadata?: Record<string, unknown>
) => log({ level: 'error', category, action, message, metadata })
