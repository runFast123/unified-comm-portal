-- =====================================================================
-- 20260504_security_hardening_and_perf_indexes
--
-- Cleans up Supabase security-advisor findings and adds one missing
-- hot-path index. Mirrors the live migration applied to the
-- mpgmwyobrzhqamtcrtjg project on 2026-05-04.
--
-- 1. Pin search_path on functions flagged by 0011_function_search_path_mutable
-- 2. Lock down internal SECURITY DEFINER functions exposed via PostgREST
--    (handle_new_auth_user trigger, check_rate_limit server-only RPC).
-- 3. Revoke anon EXECUTE on app-internal RPCs that should never be
--    callable without authentication. authenticated grants are kept so
--    Server Components / UI can still call them via the user-session
--    client.
-- 4. Add idx_conversations_assigned_to so the inbox "assigned to me"
--    filter uses an index instead of a seqscan.
-- 5. Document intentionally-empty-policy server-only tables so future
--    auditors don't mistake "RLS enabled, 0 policies" for an oversight.
-- =====================================================================

-- A. Pin search_path on functions flagged as function_search_path_mutable.
ALTER FUNCTION public.update_updated_at_column() SET search_path = public;
ALTER FUNCTION public.touch_updated_at() SET search_path = public;
ALTER FUNCTION public.touch_companies_updated_at() SET search_path = public;
ALTER FUNCTION public.sync_user_company_id() SET search_path = public;
ALTER FUNCTION public.current_user_profile() SET search_path = public;
ALTER FUNCTION public.get_dashboard_kpis() SET search_path = public;

-- B. Lock down truly internal SECURITY DEFINER functions.
--    `handle_new_auth_user` is a trigger on auth.users — should NEVER
--    be reachable via PostgREST. Triggers don't check EXECUTE privilege
--    so revoking it is safe.
--    `check_rate_limit` is called only from server-side API routes via
--    the service_role client (which bypasses these grants).
REVOKE EXECUTE ON FUNCTION public.handle_new_auth_user() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.handle_new_auth_user() FROM anon, authenticated;

REVOKE EXECUTE ON FUNCTION public.check_rate_limit(text, integer, integer) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.check_rate_limit(text, integer, integer) FROM anon, authenticated;

-- C. Revoke anon EXECUTE on app-internal RPCs. authenticated stays so
--    Server Components / UI can still call them via user-session client.
REVOKE EXECUTE ON FUNCTION public.merge_conversations(uuid, uuid, uuid) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.unmerge_conversations(uuid, uuid, uuid) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.account_ai_spend_this_month(uuid) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.conversation_timeline(uuid) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.get_dashboard_kpis() FROM PUBLIC, anon;

-- D. Hot-path index for inbox "assigned to me" filter.
CREATE INDEX IF NOT EXISTS idx_conversations_assigned_to
  ON public.conversations (assigned_to)
  WHERE assigned_to IS NOT NULL;

-- E. Document intentionally-empty-policy server-only tables. RLS is on
--    with zero policies → locked closed for anon/authenticated by design.
--    service_role bypasses RLS, so server-side API routes still work.
COMMENT ON TABLE public.assignment_state IS 'Server-only table; accessed exclusively by service_role. RLS enabled with no policies = locked closed for anon/authenticated by design.';
COMMENT ON TABLE public.pending_sends IS 'Server-only outbox; accessed exclusively by service_role. RLS enabled with no policies = locked closed for anon/authenticated by design.';
COMMENT ON TABLE public.rate_limits IS 'Server-only rate-limit buckets; accessed exclusively by service_role. RLS enabled with no policies = locked closed for anon/authenticated by design.';
