-- =====================================================================
-- 20260504_security_hardening_phase2
--
-- Phase-2 follow-up to 20260504000000. After phase-1, the Supabase
-- security advisor still flagged:
--   * 5 helpers callable by anon (is_super_admin, is_admin,
--     is_company_admin, current_user_company_id, current_user_profile).
--     Anon never has SELECT grants on the tables whose RLS uses these,
--     so anon never legitimately needs to invoke them.
--   * conversation_timeline + account_ai_spend_this_month callable by
--     authenticated. Both are only called via the service-role client
--     (createServiceRoleClient()), which bypasses grants — authenticated
--     never legitimately calls them.
--
-- Grants kept:
--   * Helpers stay callable by `authenticated` because RLS policies on
--     authenticated-readable tables call them inline.
--   * merge_conversations / unmerge_conversations stay callable by
--     authenticated — called by API routes via createServerSupabaseClient.
--   * get_dashboard_kpis stays callable by authenticated — called from
--     the dashboard page via createBrowserClient (anon key + cookie).
-- =====================================================================

-- Anon revokes (helpers).
REVOKE EXECUTE ON FUNCTION public.is_super_admin() FROM anon;
REVOKE EXECUTE ON FUNCTION public.is_admin() FROM anon;
REVOKE EXECUTE ON FUNCTION public.is_company_admin() FROM anon;
REVOKE EXECUTE ON FUNCTION public.current_user_company_id() FROM anon;
REVOKE EXECUTE ON FUNCTION public.current_user_profile() FROM anon;

-- Authenticated revokes (service-role-only RPCs).
REVOKE EXECUTE ON FUNCTION public.conversation_timeline(uuid) FROM authenticated;
REVOKE EXECUTE ON FUNCTION public.account_ai_spend_this_month(uuid) FROM authenticated;
