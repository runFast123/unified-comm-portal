-- ============================================================================
-- Multi-tenancy helper functions + RLS policy refactor.
-- Companion to 20260430150000_multi_tenancy_foundation.sql.
--
-- All helpers are SECURITY DEFINER + STABLE so they can be inlined into RLS
-- policies without triggering recursive policy evaluation. `is_admin()` is
-- updated so super_admin counts as admin too — keeps every existing
-- `is_admin()`-gated policy working without a sweep.
--
-- Policy pattern for company-scoped tables:
--   USING ( is_super_admin()
--           OR account_id IN (SELECT id FROM accounts WHERE company_id = current_user_company_id()) )
-- ============================================================================

-- Returns true if the current authenticated user has the super_admin role.
CREATE OR REPLACE FUNCTION public.is_super_admin() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.users
    WHERE id = auth.uid()
      AND role = 'super_admin'::user_role
      AND COALESCE(is_active, true)
  );
$$;

-- Returns the company_id of the currently authenticated user, or NULL.
CREATE OR REPLACE FUNCTION public.current_user_company_id() RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT company_id FROM public.users WHERE id = auth.uid();
$$;

-- Returns true if the current user is a company_admin OR the legacy admin
-- role (company-scoped going forward) OR a super_admin.
CREATE OR REPLACE FUNCTION public.is_company_admin() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.users
    WHERE id = auth.uid()
      AND role IN ('admin'::user_role, 'company_admin'::user_role, 'super_admin'::user_role)
      AND COALESCE(is_active, true)
  );
$$;

-- Update is_admin() so super_admin counts as admin (back-compat for all
-- existing admin-gated policies). Policies that need the cross-tenant
-- escape hatch should call is_super_admin() instead.
CREATE OR REPLACE FUNCTION public.is_admin() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.users
    WHERE id = auth.uid()
      AND role IN ('admin'::user_role, 'super_admin'::user_role, 'company_admin'::user_role)
  );
$$;

-- ============================================================================
-- Companies RLS — super_admin manages, others read their own.
-- ============================================================================

DROP POLICY IF EXISTS "Authenticated read companies" ON public.companies;
DROP POLICY IF EXISTS "Admins write companies" ON public.companies;
DROP POLICY IF EXISTS "Read own company" ON public.companies;
DROP POLICY IF EXISTS "Super admin manages companies" ON public.companies;

CREATE POLICY "Read own company" ON public.companies
  FOR SELECT TO authenticated USING (
    is_super_admin() OR id = current_user_company_id()
  );

CREATE POLICY "Super admin manages companies" ON public.companies
  FOR ALL TO authenticated
  USING (is_super_admin())
  WITH CHECK (is_super_admin());

-- ============================================================================
-- Accounts RLS — broaden read to company-wide; admins still write.
-- ============================================================================

DROP POLICY IF EXISTS "Authenticated users can read accounts" ON public.accounts;
DROP POLICY IF EXISTS "Users read own company accounts" ON public.accounts;

CREATE POLICY "Users read own company accounts" ON public.accounts
  FOR SELECT TO authenticated USING (
    is_super_admin()
    OR company_id = current_user_company_id()
  );

-- ============================================================================
-- Generic company-scoped tables: replace
--   account_id IN (SELECT users.account_id FROM users WHERE id=auth.uid())
-- with
--   is_super_admin() OR account_id IN (SELECT id FROM accounts WHERE company_id = current_user_company_id())
-- ============================================================================

-- conversations
DROP POLICY IF EXISTS "Users read own account conversations" ON public.conversations;
DROP POLICY IF EXISTS "Users insert own account conversations" ON public.conversations;
DROP POLICY IF EXISTS "Users update own account conversations" ON public.conversations;
DROP POLICY IF EXISTS "Users read own company conversations" ON public.conversations;
DROP POLICY IF EXISTS "Users insert own company conversations" ON public.conversations;
DROP POLICY IF EXISTS "Users update own company conversations" ON public.conversations;

CREATE POLICY "Users read own company conversations" ON public.conversations
  FOR SELECT TO authenticated USING (
    is_super_admin()
    OR account_id IN (SELECT id FROM public.accounts WHERE company_id = current_user_company_id())
  );
CREATE POLICY "Users insert own company conversations" ON public.conversations
  FOR INSERT TO authenticated WITH CHECK (
    is_super_admin()
    OR account_id IN (SELECT id FROM public.accounts WHERE company_id = current_user_company_id())
  );
CREATE POLICY "Users update own company conversations" ON public.conversations
  FOR UPDATE TO authenticated USING (
    is_super_admin()
    OR account_id IN (SELECT id FROM public.accounts WHERE company_id = current_user_company_id())
  ) WITH CHECK (
    is_super_admin()
    OR account_id IN (SELECT id FROM public.accounts WHERE company_id = current_user_company_id())
  );

-- messages
DROP POLICY IF EXISTS "Users read own account messages" ON public.messages;
DROP POLICY IF EXISTS "Users insert own account messages" ON public.messages;
DROP POLICY IF EXISTS "Users update own account messages" ON public.messages;
DROP POLICY IF EXISTS "Users read own company messages" ON public.messages;
DROP POLICY IF EXISTS "Users insert own company messages" ON public.messages;
DROP POLICY IF EXISTS "Users update own company messages" ON public.messages;

CREATE POLICY "Users read own company messages" ON public.messages
  FOR SELECT TO authenticated USING (
    is_super_admin()
    OR account_id IN (SELECT id FROM public.accounts WHERE company_id = current_user_company_id())
  );
CREATE POLICY "Users insert own company messages" ON public.messages
  FOR INSERT TO authenticated WITH CHECK (
    is_super_admin()
    OR account_id IN (SELECT id FROM public.accounts WHERE company_id = current_user_company_id())
  );
CREATE POLICY "Users update own company messages" ON public.messages
  FOR UPDATE TO authenticated USING (
    is_super_admin()
    OR account_id IN (SELECT id FROM public.accounts WHERE company_id = current_user_company_id())
  ) WITH CHECK (
    is_super_admin()
    OR account_id IN (SELECT id FROM public.accounts WHERE company_id = current_user_company_id())
  );

-- ai_replies
DROP POLICY IF EXISTS "Users read own account ai_replies" ON public.ai_replies;
DROP POLICY IF EXISTS "Users insert own account ai_replies" ON public.ai_replies;
DROP POLICY IF EXISTS "Users update own account ai_replies" ON public.ai_replies;
DROP POLICY IF EXISTS "Users read own company ai_replies" ON public.ai_replies;
DROP POLICY IF EXISTS "Users insert own company ai_replies" ON public.ai_replies;
DROP POLICY IF EXISTS "Users update own company ai_replies" ON public.ai_replies;

CREATE POLICY "Users read own company ai_replies" ON public.ai_replies
  FOR SELECT TO authenticated USING (
    is_super_admin()
    OR account_id IN (SELECT id FROM public.accounts WHERE company_id = current_user_company_id())
  );
CREATE POLICY "Users insert own company ai_replies" ON public.ai_replies
  FOR INSERT TO authenticated WITH CHECK (
    is_super_admin()
    OR account_id IN (SELECT id FROM public.accounts WHERE company_id = current_user_company_id())
  );
CREATE POLICY "Users update own company ai_replies" ON public.ai_replies
  FOR UPDATE TO authenticated USING (
    is_super_admin()
    OR account_id IN (SELECT id FROM public.accounts WHERE company_id = current_user_company_id())
  ) WITH CHECK (
    is_super_admin()
    OR account_id IN (SELECT id FROM public.accounts WHERE company_id = current_user_company_id())
  );

-- message_classifications (joined through messages.account_id)
DROP POLICY IF EXISTS "Users read own account message_classifications" ON public.message_classifications;
DROP POLICY IF EXISTS "Users read own company message_classifications" ON public.message_classifications;

CREATE POLICY "Users read own company message_classifications" ON public.message_classifications
  FOR SELECT TO authenticated USING (
    is_super_admin()
    OR EXISTS (
      SELECT 1 FROM public.messages m
      WHERE m.id = message_classifications.message_id
        AND m.account_id IN (SELECT id FROM public.accounts WHERE company_id = current_user_company_id())
    )
  );

-- scheduled_messages
DROP POLICY IF EXISTS "Users read own account scheduled_messages" ON public.scheduled_messages;
DROP POLICY IF EXISTS "Users insert own account scheduled_messages" ON public.scheduled_messages;
DROP POLICY IF EXISTS "Users update own account scheduled_messages" ON public.scheduled_messages;
DROP POLICY IF EXISTS "Users read own company scheduled_messages" ON public.scheduled_messages;
DROP POLICY IF EXISTS "Users insert own company scheduled_messages" ON public.scheduled_messages;
DROP POLICY IF EXISTS "Users update own company scheduled_messages" ON public.scheduled_messages;

CREATE POLICY "Users read own company scheduled_messages" ON public.scheduled_messages
  FOR SELECT TO authenticated USING (
    is_super_admin()
    OR account_id IN (SELECT id FROM public.accounts WHERE company_id = current_user_company_id())
  );
CREATE POLICY "Users insert own company scheduled_messages" ON public.scheduled_messages
  FOR INSERT TO authenticated WITH CHECK (
    is_super_admin()
    OR account_id IN (SELECT id FROM public.accounts WHERE company_id = current_user_company_id())
  );
CREATE POLICY "Users update own company scheduled_messages" ON public.scheduled_messages
  FOR UPDATE TO authenticated USING (
    is_super_admin()
    OR account_id IN (SELECT id FROM public.accounts WHERE company_id = current_user_company_id())
  ) WITH CHECK (
    is_super_admin()
    OR account_id IN (SELECT id FROM public.accounts WHERE company_id = current_user_company_id())
  );

-- ai_usage (read-only company-scoped)
DROP POLICY IF EXISTS "Users read own account ai_usage" ON public.ai_usage;
DROP POLICY IF EXISTS "Users read own company ai_usage" ON public.ai_usage;

CREATE POLICY "Users read own company ai_usage" ON public.ai_usage
  FOR SELECT TO authenticated USING (
    is_super_admin()
    OR account_id IN (SELECT id FROM public.accounts WHERE company_id = current_user_company_id())
  );

-- Promote the original admin to super_admin so they retain platform-wide
-- visibility. Other admins remain company-scoped under the new model.
UPDATE public.users SET role = 'super_admin'
WHERE email = 'amanbimcm@gmail.com' AND role = 'admin';
