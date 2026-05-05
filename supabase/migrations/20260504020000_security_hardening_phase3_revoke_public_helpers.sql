-- =====================================================================
-- 20260504_security_hardening_phase3
--
-- Phase-2 missed that the 5 helpers retain a PUBLIC EXECUTE grant
-- (shown as `-` grantee in pg_proc.proacl). That grant is what makes
-- them anon-callable: anon inherits EXECUTE from PUBLIC. Revoking from
-- anon alone is a no-op as long as PUBLIC still has it.
--
-- This fully revokes PUBLIC. Authenticated keeps its explicit grant
-- (separate from PUBLIC), so RLS policies that call these helpers
-- continue to work for signed-in users. Anon, having no explicit
-- grant, loses access entirely.
-- =====================================================================

REVOKE EXECUTE ON FUNCTION public.is_super_admin() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.is_admin() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.is_company_admin() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.current_user_company_id() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.current_user_profile() FROM PUBLIC;
