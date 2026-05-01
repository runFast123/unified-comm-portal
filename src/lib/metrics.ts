/**
 * Lightweight, structured metrics ingestion.
 *
 * `recordMetric(name, value, labels?)` buffers events in-memory and flushes
 * them in batches to the `metrics_events` table — every 10s OR when the
 * buffer hits 100 events, whichever comes first. Flushes use Next.js'
 * `after()` so they never block the request that triggered them.
 *
 * Design rules — observability bugs MUST NEVER break callers:
 *   1. recordMetric NEVER throws. Bad inputs are dropped silently.
 *   2. Flushes swallow all errors (logged, but never re-thrown).
 *   3. The buffer has a hard cap so a flush outage can't OOM the lambda.
 *   4. Service-role insert bypasses RLS — no auth round-trips on the hot path.
 */

import { after } from 'next/server'

// ─── Tunables ──────────────────────────────────────────────────────────
//
// Tuned to be friendly to Vercel's serverless model: batches are small enough
// that even a 250ms request can flush its own metrics inline, but big enough
// that a busy webhook doesn't generate 1 RTT per event.
const FLUSH_INTERVAL_MS = 10_000
const FLUSH_BATCH_SIZE = 100
// Hard cap on the in-memory buffer. If a flush is failing repeatedly we
// drop the oldest events rather than letting the buffer grow without bound.
const BUFFER_MAX = 1000

// ─── Types ─────────────────────────────────────────────────────────────

export type MetricLabels = Record<string, string | number | boolean | null | undefined>

interface BufferedEvent {
  ts: string
  metric_name: string
  value: number
  labels: MetricLabels | null
  request_id: string | null
}

// ─── In-process buffer ────────────────────────────────────────────────
//
// Module-level state. In Vercel serverless this lives for the lambda's
// lifetime — typically a few minutes — so we get useful batching without
// risking long-term unbounded growth. Cold starts re-zero everything,
// which is fine; the events queued during the previous lambda's lifetime
// were already flushed (or lost if the lambda crashed mid-batch, which is
// acceptable for non-critical observability data).
const buffer: BufferedEvent[] = []
let flushTimer: ReturnType<typeof setTimeout> | null = null

/**
 * Strip `undefined` values from labels and coerce them to JSON-friendly
 * primitives. Returns `null` for an empty object so the DB column stays
 * tidy.
 */
function normalizeLabels(labels?: MetricLabels): MetricLabels | null {
  if (!labels) return null
  const out: Record<string, string | number | boolean | null> = {}
  for (const [k, v] of Object.entries(labels)) {
    if (v === undefined) continue
    out[k] = v as string | number | boolean | null
  }
  return Object.keys(out).length > 0 ? out : null
}

/**
 * Schedule a `setTimeout`-driven flush after FLUSH_INTERVAL_MS. Idempotent:
 * if a timer is already pending, this is a no-op. The timer always re-arms
 * itself on flush so a steady drip of events doesn't get stuck waiting.
 */
function scheduleFlush(): void {
  if (flushTimer) return
  flushTimer = setTimeout(() => {
    flushTimer = null
    void flushNow()
  }, FLUSH_INTERVAL_MS)
  // Don't keep a Lambda alive just to flush — the framework will tear down
  // the runtime after the response anyway, and `after()` covers the
  // post-response window for the eager flushes.
  if (typeof flushTimer === 'object' && flushTimer !== null && 'unref' in flushTimer) {
    try {
      ;(flushTimer as unknown as { unref: () => void }).unref()
    } catch {
      // unref doesn't exist in some test environments — ignore.
    }
  }
}

/**
 * Drain the buffer and POST the batch to the `metrics_events` table via the
 * Supabase REST endpoint. We use raw fetch + service-role key to avoid
 * pulling in the full `@supabase/supabase-js` client on this hot path —
 * the import cost matters in cold-start latency.
 *
 * Errors are caught and logged to console only; nothing here re-throws.
 * If the flush fails the events are LOST (we don't requeue) — this is a
 * deliberate tradeoff: requeuing risks unbounded growth and stuck buffers
 * during sustained outages. Metrics are best-effort.
 */
export async function flushNow(): Promise<void> {
  if (buffer.length === 0) return
  const batch = buffer.splice(0, buffer.length)

  try {
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
    if (!supabaseUrl || !serviceKey) {
      // Misconfigured env — silently drop. Logging here would risk a
      // recursive observability storm if logger is also broken.
      return
    }

    const res = await fetch(`${supabaseUrl}/rest/v1/metrics_events`, {
      method: 'POST',
      headers: {
        apikey: serviceKey,
        Authorization: `Bearer ${serviceKey}`,
        'Content-Type': 'application/json',
        Prefer: 'return=minimal',
      },
      body: JSON.stringify(
        batch.map((e) => ({
          ts: e.ts,
          metric_name: e.metric_name,
          value: e.value,
          labels: e.labels,
          request_id: e.request_id,
        }))
      ),
    })
    // fetch() doesn't throw on non-2xx — explicit check so a 401/400 doesn't
    // silently swallow the entire batch. Without this every metric event
    // disappeared on a column-mismatch or auth-misconfiguration with no
    // operator-visible signal. Console-only to avoid recursion through the
    // structured logger (which itself writes to audit_log).
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      // eslint-disable-next-line no-console
      console.warn(
        `[metrics] flush HTTP ${res.status}: dropped ${batch.length} events. body=${body.slice(0, 200)}`
      )
    }
  } catch (err) {
    // Console only — the structured logger writes to audit_log, and we don't
    // want a metrics flush failure to spam audit_log every 10 seconds.
    // eslint-disable-next-line no-console
    console.warn('[metrics] flush failed:', err instanceof Error ? err.message : err)
  }
}

/**
 * Schedule an eager flush via Next.js' `after()` so it runs AFTER the
 * response is sent — never blocks the user-facing request. Falls back to
 * a microtask if `after()` isn't available (e.g. unit tests, scripts).
 */
function eagerFlush(): void {
  try {
    after(() => flushNow())
  } catch {
    // `after()` is only valid inside a Next.js request context. Outside
    // of that (tests, CLI scripts, top-level imports) it throws — fall
    // back to a fire-and-forget Promise so we still drain the buffer.
    void flushNow()
  }
}

/**
 * Public API — record a single metric event.
 *
 *   recordMetric('cron.email_poll.duration_ms', 1234, { shard: 0 })
 *   recordMetric('webhook.email.ingested', 1, { account_id, is_spam: false })
 *
 * MUST NEVER THROW. All input validation is best-effort; bad inputs are
 * silently dropped so a logging bug can't take down a webhook.
 */
export function recordMetric(
  name: string,
  value: number,
  labels?: MetricLabels,
  requestId?: string | null
): void {
  try {
    if (typeof name !== 'string' || name.length === 0) return
    const numericValue = Number(value)
    if (!Number.isFinite(numericValue)) return

    // Drop oldest if we're at the hard cap (back-pressure / outage scenario).
    if (buffer.length >= BUFFER_MAX) {
      buffer.shift()
    }

    buffer.push({
      ts: new Date().toISOString(),
      metric_name: name,
      value: numericValue,
      labels: normalizeLabels(labels),
      request_id: typeof requestId === 'string' && requestId.length > 0 ? requestId : null,
    })

    // ALWAYS schedule via after() — the setTimeout-based scheduleFlush()
    // path doesn't work on Vercel because the lambda is torn down once
    // the response is sent (the timer is .unref()'d so it can't keep the
    // runtime alive). Cron routes only buffer 3-5 metrics per run — far
    // below the 100-event eager threshold — so without after() the
    // metrics_events table never received any writes from cron.
    //
    // after() keeps the lambda alive until the post-response callback
    // completes, which is exactly when we want to flush. Multiple
    // recordMetric calls in the same request register multiple after()
    // callbacks; the first one drains the buffer, the rest no-op
    // harmlessly.
    //
    // Tests set METRICS_DISABLE_AUTO_FLUSH=1 so they can inspect the
    // buffer without a sneaky drain happening between push and assert.
    if (process.env.METRICS_DISABLE_AUTO_FLUSH !== '1') {
      eagerFlush()
      // Keep the setTimeout fallback for environments without a request
      // context (e.g. background scripts). It's a no-op on Vercel because
      // of the .unref() but doesn't hurt.
      if (buffer.length < FLUSH_BATCH_SIZE) {
        scheduleFlush()
      }
    }
  } catch {
    // Belt-and-braces: even if normalize / scheduling throw, swallow.
  }
}

// ─── Test-only helpers ────────────────────────────────────────────────

/** Snapshot of buffered events. EXPORTED FOR TESTS — do not use in product code. */
export function __getBufferForTests(): BufferedEvent[] {
  return [...buffer]
}

/** Clear the buffer. EXPORTED FOR TESTS — do not use in product code. */
export function __resetBufferForTests(): void {
  buffer.length = 0
  if (flushTimer) {
    clearTimeout(flushTimer)
    flushTimer = null
  }
}
