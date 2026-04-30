import { NextResponse } from 'next/server'
import { pollAllEmailAccounts } from '@/lib/email-poller'
import { validateWebhookSecret } from '@/lib/api-helpers'
import { getRequestId } from '@/lib/request-id'
import { logInfo, logError } from '@/lib/logger'
import { recordMetric } from '@/lib/metrics'

/**
 * Accept either `X-Webhook-Secret` (internal callers) or
 * `Authorization: Bearer <secret>` (Vercel Cron). Delegates to the shared
 * timing-safe validator in api-helpers.ts.
 */
function authorizeCron(request: Request): boolean {
  if (validateWebhookSecret(request)) return true
  const auth = request.headers.get('authorization')
  const bearer = auth?.startsWith('Bearer ') ? auth.slice(7) : null
  if (!bearer) return false
  const shim = new Request(request.url, {
    method: 'GET',
    headers: { 'x-webhook-secret': bearer },
  })
  return validateWebhookSecret(shim)
}

/**
 * Parse `?shard=N&total=M` query params. Both must be integers; we clamp
 * `total` to [1, 64] (64 shards is well past anything we'd ever need on
 * Vercel Cron's free tier) and `shard` to [0, total-1]. Missing/invalid
 * values fall back to {0, 1} which is the pre-sharding behavior.
 */
function parseShardParams(url: URL): { shard: number; total: number } {
  const totalRaw = Number(url.searchParams.get('total'))
  const shardRaw = Number(url.searchParams.get('shard'))
  const total =
    Number.isFinite(totalRaw) && Number.isInteger(totalRaw)
      ? Math.max(1, Math.min(64, totalRaw))
      : 1
  const shard =
    Number.isFinite(shardRaw) && Number.isInteger(shardRaw)
      ? Math.max(0, Math.min(total - 1, shardRaw))
      : 0
  return { shard, total }
}

// GET/POST /api/cron/email-poll
//   Auth: X-Webhook-Secret header matching WEBHOOK_SECRET.
//   Vercel Cron sends `Authorization: Bearer <CRON_SECRET>` — accepted too.
//   Sharding (optional): ?shard=N&total=M restricts this run to a slice of
//   accounts so the cron schedule can fan out across multiple Lambdas.
export async function GET(request: Request) {
  const requestId = await getRequestId()
  if (!authorizeCron(request)) {
    return NextResponse.json({ error: 'Unauthorized', request_id: requestId }, { status: 401 })
  }

  const url = new URL(request.url)
  const origin = url.origin
  const { shard, total } = parseShardParams(url)
  const startedAt = Date.now()
  logInfo('system', 'email_poll_start', `email cron started (shard ${shard}/${total})`, {
    request_id: requestId,
    shard,
    total,
  })

  try {
    const results = await pollAllEmailAccounts(origin, { shard, total }, requestId)
    const summary = results.reduce(
      (acc, r) => ({
        accounts: acc.accounts + 1,
        fetched: acc.fetched + r.fetched,
        forwarded: acc.forwarded + r.forwarded,
        errors: acc.errors + r.errors.length,
      }),
      { accounts: 0, fetched: 0, forwarded: 0, errors: 0 }
    )
    const durationMs = Date.now() - startedAt
    logInfo('system', 'email_poll_end', `email cron finished`, {
      request_id: requestId,
      shard,
      total,
      ...summary,
      duration_ms: durationMs,
    })

    // ── Operational metrics ────────────────────────────────────────────
    // Duration always recorded (success path). `success` label distinguishes
    // these rows from the error catch's matching emit below so the dashboard
    // can compute success-rate without joining on a separate counter.
    recordMetric('cron.email_poll.duration_ms', durationMs, { shard, total, success: true }, requestId)
    recordMetric('cron.email_poll.fetched', summary.fetched, { shard, total }, requestId)
    if (summary.errors > 0) {
      recordMetric('cron.email_poll.errors', summary.errors, { shard, total }, requestId)
    }
    // `webhook.email.ingested` mirrors per-message ingest count — the email
    // ingest core itself is off-limits, so we emit the aggregate here from
    // the cron's summary. Per-message labels (account, is_spam) are not
    // available at this layer; the dashboard shows the count only.
    if (summary.fetched > 0) {
      recordMetric('webhook.email.ingested', summary.fetched, { source: 'cron', shard }, requestId)
    }

    return NextResponse.json({ shard, total, summary, results, request_id: requestId })
  } catch (err) {
    const durationMs = Date.now() - startedAt
    logError('system', 'email_poll_error', err instanceof Error ? err.message : 'unknown', {
      request_id: requestId,
      shard,
      total,
      duration_ms: durationMs,
    })
    recordMetric('cron.email_poll.duration_ms', durationMs, { shard, total, success: false }, requestId)
    recordMetric('cron.email_poll.errors', 1, { shard, total, fatal: true }, requestId)
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Internal error', request_id: requestId },
      { status: 500 }
    )
  }
}

export const POST = GET
