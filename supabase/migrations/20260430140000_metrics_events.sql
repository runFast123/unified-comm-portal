-- ============================================================================
-- metrics_events: lightweight, structured operational metrics.
--
-- Counter / gauge / histogram events written by `recordMetric()` in
-- src/lib/metrics.ts. Used by the /admin/observability dashboard to compute
-- SLIs (cron success rate, ingest latency, AI cost, etc.) without grepping
-- raw stdout logs.
--
-- Writers: service role (bypasses RLS). Readers: admins via dashboard.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.metrics_events (
  id          bigserial PRIMARY KEY,
  ts          timestamptz NOT NULL DEFAULT now(),
  metric_name text        NOT NULL,
  value       numeric     NOT NULL,
  labels      jsonb,
  request_id  text
);

-- Most queries are "give me events of this name in the last N minutes",
-- so the (name, ts DESC) composite is the primary access path.
CREATE INDEX IF NOT EXISTS idx_metrics_events_name_ts
  ON public.metrics_events (metric_name, ts DESC);

-- Plain ts index covers cross-metric "what happened recently" scans.
CREATE INDEX IF NOT EXISTS idx_metrics_events_ts
  ON public.metrics_events (ts DESC);

ALTER TABLE public.metrics_events ENABLE ROW LEVEL SECURITY;

-- Admin read-only. Service role (used by recordMetric flushes) bypasses RLS,
-- so no INSERT/UPDATE policy is needed.
DROP POLICY IF EXISTS "Admins read metrics" ON public.metrics_events;
CREATE POLICY "Admins read metrics" ON public.metrics_events
  FOR SELECT TO authenticated USING (is_admin());
