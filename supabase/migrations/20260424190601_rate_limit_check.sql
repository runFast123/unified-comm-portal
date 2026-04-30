-- ============================================================================
-- Rate limiting: atomic fixed-window counter backed by public.rate_limits
-- ============================================================================
--
-- Why: the app previously used an in-process `Map` for rate limiting. On
-- Vercel serverless each Lambda has its own Map, so the effective cap was
-- `instances × MAX`. This RPC moves enforcement to the database so the
-- counter is shared across every Lambda instance.
--
-- Algorithm (fixed-window counter):
--   * First call for a key:               insert row, count = 1.
--   * Subsequent call within window:      increment count.
--   * Subsequent call after window expired: reset count to 1 and slide the
--     window to `now()`.
-- Everything happens in a single `INSERT ... ON CONFLICT DO UPDATE`, which
-- Postgres executes atomically, so concurrent calls from different Lambdas
-- can't race past the limit.
--
-- Return: one row with
--   allowed  boolean    -- post-increment count <= p_max
--   remaining integer    -- max - count, floored at 0
--   reset_at timestamptz -- when the current window ends
--
-- Callers should fail open on RPC errors — a broken counter must not take
-- the app down.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.check_rate_limit(
  p_key text,
  p_max integer,
  p_window_seconds integer
) RETURNS TABLE (allowed boolean, remaining integer, reset_at timestamptz)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  r public.rate_limits%ROWTYPE;
  now_ts timestamptz := now();
BEGIN
  INSERT INTO public.rate_limits (key, count, window_start)
  VALUES (p_key, 1, now_ts)
  ON CONFLICT (key) DO UPDATE
    SET count = CASE
      WHEN public.rate_limits.window_start < now_ts - make_interval(secs => p_window_seconds)
      THEN 1
      ELSE public.rate_limits.count + 1
    END,
    window_start = CASE
      WHEN public.rate_limits.window_start < now_ts - make_interval(secs => p_window_seconds)
      THEN now_ts
      ELSE public.rate_limits.window_start
    END
  RETURNING * INTO r;

  RETURN QUERY SELECT
    (r.count <= p_max)                                      AS allowed,
    greatest(p_max - r.count, 0)                            AS remaining,
    (r.window_start + make_interval(secs => p_window_seconds)) AS reset_at;
END;
$$;

GRANT EXECUTE ON FUNCTION public.check_rate_limit(text, integer, integer) TO service_role;
