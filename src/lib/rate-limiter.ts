/**
 * DB-backed fixed-window rate limiter.
 *
 * Replaces the in-process `Map` that used to live in `api-helpers.ts`. On
 * Vercel serverless each Lambda had its own copy of that Map, so the real
 * cap was `instances × MAX` — effectively no limit under load. This module
 * delegates enforcement to a Postgres RPC so the counter is shared across
 * every instance.
 *
 * Migration that creates the RPC lives at
 *   supabase/migrations/20260424190601_rate_limit_check.sql
 *
 * SQL seed (apply via the Supabase MCP if this hasn't been applied yet):
 *
 *   CREATE OR REPLACE FUNCTION public.check_rate_limit(
 *     p_key text,
 *     p_max integer,
 *     p_window_seconds integer
 *   ) RETURNS TABLE (allowed boolean, remaining integer, reset_at timestamptz)
 *   LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
 *   DECLARE
 *     r public.rate_limits%ROWTYPE;
 *     now_ts timestamptz := now();
 *   BEGIN
 *     INSERT INTO public.rate_limits (key, count, window_start)
 *     VALUES (p_key, 1, now_ts)
 *     ON CONFLICT (key) DO UPDATE
 *       SET count = CASE
 *         WHEN public.rate_limits.window_start < now_ts - make_interval(secs => p_window_seconds)
 *         THEN 1 ELSE public.rate_limits.count + 1 END,
 *         window_start = CASE
 *         WHEN public.rate_limits.window_start < now_ts - make_interval(secs => p_window_seconds)
 *         THEN now_ts ELSE public.rate_limits.window_start END
 *     RETURNING * INTO r;
 *     RETURN QUERY SELECT
 *       (r.count <= p_max) AS allowed,
 *       greatest(p_max - r.count, 0) AS remaining,
 *       (r.window_start + make_interval(secs => p_window_seconds)) AS reset_at;
 *   END; $$;
 *   GRANT EXECUTE ON FUNCTION public.check_rate_limit TO service_role;
 *
 * Fail-open policy: if the RPC call errors (network, missing function,
 * schema drift, anything) we log and allow the request through. Dropping
 * all traffic because the rate limiter is broken is worse than temporarily
 * lifting the cap.
 */

import { createServiceRoleClient } from '@/lib/supabase-server'
import { logError } from '@/lib/logger'

export interface RateLimitResult {
  allowed: boolean
  remaining: number
  reset_at: Date
}

/**
 * Common rate-limit presets. `max` is per window, `windowSeconds` is window length.
 * Keys should be namespaced per-caller (e.g. `send:email:${account_id}`).
 */
export const RATE_LIMITS = {
  WEBHOOK_PER_ACCOUNT: { max: 100, windowSeconds: 60 },
  SEND_PER_ACCOUNT: { max: 30, windowSeconds: 60 },
  TEST_CONNECTION: { max: 10, windowSeconds: 60 },
  SCHEDULED_CREATE: { max: 50, windowSeconds: 300 },
  ATTACHMENT_UPLOAD: { max: 20, windowSeconds: 60 },
} as const

/**
 * Check whether a request for `key` should be allowed under the given
 * fixed-window budget. Atomic — safe under concurrent Lambdas.
 *
 * Fails open (`allowed: true`) if the underlying RPC errors, and logs so
 * operators can see when the limiter isn't actually enforcing.
 */
export async function checkRateLimit(
  key: string,
  maxPerWindow = 100,
  windowSeconds = 60
): Promise<RateLimitResult> {
  try {
    const supabase = await createServiceRoleClient()
    const { data, error } = await supabase.rpc('check_rate_limit', {
      p_key: key,
      p_max: maxPerWindow,
      p_window_seconds: windowSeconds,
    })

    if (error) {
      await logError(
        'system',
        'rate_limit.rpc_error',
        `check_rate_limit RPC failed for key=${key}: ${error.message}`,
        { key, maxPerWindow, windowSeconds, code: error.code }
      )
      return failOpen(maxPerWindow, windowSeconds)
    }

    // RPC returns setof — pick the single row.
    const row = Array.isArray(data) ? data[0] : data
    if (!row) {
      await logError(
        'system',
        'rate_limit.empty_result',
        `check_rate_limit returned no row for key=${key}`,
        { key }
      )
      return failOpen(maxPerWindow, windowSeconds)
    }

    return {
      allowed: Boolean(row.allowed),
      remaining: Number(row.remaining ?? 0),
      reset_at: new Date(row.reset_at),
    }
  } catch (err) {
    await logError(
      'system',
      'rate_limit.exception',
      `check_rate_limit threw for key=${key}: ${err instanceof Error ? err.message : String(err)}`,
      { key, maxPerWindow, windowSeconds }
    )
    return failOpen(maxPerWindow, windowSeconds)
  }
}

function failOpen(maxPerWindow: number, windowSeconds: number): RateLimitResult {
  return {
    allowed: true,
    remaining: maxPerWindow,
    reset_at: new Date(Date.now() + windowSeconds * 1000),
  }
}
