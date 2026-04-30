import { NextResponse } from 'next/server'
import { createServiceRoleClient } from '@/lib/supabase-server'
import { validateWebhookSecret } from '@/lib/api-helpers'
import { logError, logInfo } from '@/lib/logger'
import { getRequestId } from '@/lib/request-id'
import { recordMetric } from '@/lib/metrics'

// Per-run cap so a long backlog never monopolises one invocation. Cron fires
// once per minute, so we'll catch up over a few cycles even if 1000+ rows
// happen to expire at once.
const BATCH_LIMIT = 200

interface SnoozedRow {
  id: string
  account_id: string
  status: string | null
  snoozed_until: string
}

/**
 * Authorize cron invocation. Accepts either `X-Webhook-Secret` (internal
 * callers) or `Authorization: Bearer <WEBHOOK_SECRET>` (Vercel Cron).
 * Both routes use timing-safe comparison via validateWebhookSecret.
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
 * Cron: wake conversations whose snooze has expired.
 *
 * For every conversation where `snoozed_until <= now()`:
 *   1. Clear `snoozed_until` and `snoozed_by`.
 *   2. If the conversation status is `resolved`, flip it back to `active`
 *      so the user actually sees it in their inbox again.
 *   3. Log `conversation.snooze_expired` to audit_log.
 *
 * Uses the partial index `idx_conversations_snoozed` to keep the SELECT cheap.
 */
export async function GET(request: Request) {
  const requestId = await getRequestId()
  if (!authorizeCron(request)) {
    return NextResponse.json(
      { error: 'Unauthorized', request_id: requestId },
      { status: 401 }
    )
  }

  const admin = await createServiceRoleClient()
  const nowIso = new Date().toISOString()
  const startedAt = Date.now()
  logInfo('system', 'wake_snoozed_start', 'wake-snoozed cron started', {
    request_id: requestId,
  })

  // The partial index `idx_conversations_snoozed` covers `snoozed_until IS NOT
  // NULL`, so the `.lte` filter rides that index for an O(log n) scan.
  const { data: rows, error } = await admin
    .from('conversations')
    .select('id, account_id, status, snoozed_until')
    .not('snoozed_until', 'is', null)
    .lte('snoozed_until', nowIso)
    .order('snoozed_until', { ascending: true })
    .limit(BATCH_LIMIT)

  if (error) {
    const durationMs = Date.now() - startedAt
    logError('system', 'wake_snoozed_query_error', error.message, {
      request_id: requestId,
    })
    recordMetric('cron.wake_snoozed.duration_ms', durationMs, { success: false }, requestId)
    recordMetric('cron.wake_snoozed.errors', 1, { stage: 'query', fatal: true }, requestId)
    return NextResponse.json(
      { error: error.message, request_id: requestId },
      { status: 500 }
    )
  }

  const due = (rows ?? []) as SnoozedRow[]
  let woken = 0
  let reopened = 0
  let failed = 0
  const errors: Array<{ id: string; error: string }> = []

  for (const row of due) {
    try {
      // ── Compare-and-set: clear snooze ONLY if it's still <= now. Avoids
      //    racing with a user who unsnoozed (or re-snoozed) in the gap
      //    between SELECT and UPDATE.
      const updateFields: Record<string, unknown> = {
        snoozed_until: null,
        snoozed_by: null,
      }
      const shouldReopen = row.status === 'resolved'
      if (shouldReopen) {
        updateFields.status = 'active'
      }

      const { data: claimed, error: claimErr } = await admin
        .from('conversations')
        .update(updateFields)
        .eq('id', row.id)
        .eq('snoozed_until', row.snoozed_until)
        .select('id')
        .maybeSingle()

      if (claimErr) {
        errors.push({ id: row.id, error: claimErr.message })
        failed++
        continue
      }
      if (!claimed) {
        // The row changed out from under us (user unsnoozed / re-snoozed).
        // That's fine — not an error, just skip.
        continue
      }

      woken++
      if (shouldReopen) reopened++

      // Audit log (best-effort).
      try {
        await admin.from('audit_log').insert({
          user_id: null,
          action: 'conversation.snooze_expired',
          entity_type: 'conversation',
          entity_id: row.id,
          details: {
            account_id: row.account_id,
            previous_snoozed_until: row.snoozed_until,
            reopened: shouldReopen,
            request_id: requestId,
          },
        })
      } catch {
        /* non-critical */
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'wake failed'
      errors.push({ id: row.id, error: message })
      failed++
    }
  }

  const durationMs = Date.now() - startedAt
  logInfo('system', 'wake_snoozed_end', 'wake-snoozed cron finished', {
    request_id: requestId,
    woken,
    reopened,
    failed,
    duration_ms: durationMs,
  })

  // Cron success here is "we ran without crashing" — per-row failures are
  // tracked in the errors counter so a partial failure still counts as a
  // successful run for SLA purposes (Vercel didn't 500).
  recordMetric('cron.wake_snoozed.duration_ms', durationMs, { success: true }, requestId)
  recordMetric('cron.wake_snoozed.fetched', woken, undefined, requestId)
  if (failed > 0) {
    recordMetric('cron.wake_snoozed.errors', failed, { stage: 'per_row' }, requestId)
  }

  return NextResponse.json({
    woken,
    reopened,
    failed,
    errors,
    request_id: requestId,
  })
}

// Vercel Cron sends GET — also accept POST for parity with other crons.
export const POST = GET
