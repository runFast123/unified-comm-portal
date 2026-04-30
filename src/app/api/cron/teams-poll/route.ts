import { NextResponse } from 'next/server'
import { pollAllTeamsAccounts } from '@/lib/teams-poller'
import { validateWebhookSecret } from '@/lib/api-helpers'
import { getRequestId } from '@/lib/request-id'
import { logInfo, logError } from '@/lib/logger'

/**
 * Accept either `X-Webhook-Secret` or `Authorization: Bearer <secret>`.
 * Both are compared timing-safely via the shared helper.
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
 * Parse `?shard=N&total=M`. See email-poll/route.ts for full semantics —
 * we duplicate the helper rather than share it because the routes are
 * intentionally self-contained and the function is 12 lines.
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

// GET/POST /api/cron/teams-poll
//   Auth: X-Webhook-Secret header or Authorization: Bearer <WEBHOOK_SECRET>
//   Sharding (optional): ?shard=N&total=M — see email-poll/route.ts.
export async function GET(request: Request) {
  const requestId = await getRequestId()
  if (!authorizeCron(request)) {
    return NextResponse.json({ error: 'Unauthorized', request_id: requestId }, { status: 401 })
  }

  const url = new URL(request.url)
  const origin = url.origin
  const { shard, total } = parseShardParams(url)
  const startedAt = Date.now()
  logInfo('system', 'teams_poll_start', `teams cron started (shard ${shard}/${total})`, {
    request_id: requestId,
    shard,
    total,
  })

  try {
    const results = await pollAllTeamsAccounts(origin, { shard, total }, requestId)
    const summary = results.reduce(
      (acc, r) => ({
        accounts: acc.accounts + 1,
        fetched: acc.fetched + r.fetched,
        forwarded: acc.forwarded + r.forwarded,
        errors: acc.errors + r.errors.length,
      }),
      { accounts: 0, fetched: 0, forwarded: 0, errors: 0 }
    )
    logInfo('system', 'teams_poll_end', `teams cron finished`, {
      request_id: requestId,
      shard,
      total,
      ...summary,
      duration_ms: Date.now() - startedAt,
    })
    return NextResponse.json({ shard, total, summary, results, request_id: requestId })
  } catch (err) {
    logError('system', 'teams_poll_error', err instanceof Error ? err.message : 'unknown', {
      request_id: requestId,
      shard,
      total,
      duration_ms: Date.now() - startedAt,
    })
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Internal error', request_id: requestId },
      { status: 500 }
    )
  }
}

export const POST = GET
