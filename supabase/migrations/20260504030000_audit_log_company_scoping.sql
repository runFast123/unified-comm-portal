-- =====================================================================
-- 20260504_audit_log_company_scoping
--
-- Closes a cross-tenant leak in audit_log. Previously the SELECT policy
-- was just `is_admin()` — every company_admin could read every other
-- tenant's audit events. This migration:
--
-- 1. Adds a company_id column (nullable; system events keep NULL).
-- 2. Backfills existing rows from users.company_id via user_id join.
-- 3. Indexes company_id for the new RLS predicate.
-- 4. Replaces the leaky SELECT policy with a company-scoped one:
--    super_admin sees everything; admins see only their tenant's rows.
--    Rows with NULL company_id are super-admin-only by design.
-- 5. Adds a BEFORE INSERT trigger that auto-fills company_id from the
--    inserting user's profile, so application code can't accidentally
--    drop the scope.
-- =====================================================================

-- 1. Column
ALTER TABLE public.audit_log
  ADD COLUMN IF NOT EXISTS company_id uuid REFERENCES public.companies(id) ON DELETE SET NULL;

-- 2. Backfill from existing user_id linkage
UPDATE public.audit_log al
SET company_id = u.company_id
FROM public.users u
WHERE al.user_id = u.id
  AND al.company_id IS NULL
  AND u.company_id IS NOT NULL;

-- 3. Index for the RLS predicate
CREATE INDEX IF NOT EXISTS idx_audit_log_company_id
  ON public.audit_log(company_id);

-- 4. Replace SELECT policy
DROP POLICY IF EXISTS "Admins read audit_log" ON public.audit_log;
DROP POLICY IF EXISTS "Admins read audit_log company-scoped" ON public.audit_log;
CREATE POLICY "Admins read audit_log company-scoped"
  ON public.audit_log
  FOR SELECT
  TO authenticated
  USING (
    public.is_super_admin()
    OR (
      public.is_admin()
      AND company_id IS NOT NULL
      AND company_id = public.current_user_company_id()
    )
  );

-- 5. Auto-fill trigger so callers don't have to remember
CREATE OR REPLACE FUNCTION public.audit_log_fill_company_id()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.company_id IS NULL AND NEW.user_id IS NOT NULL THEN
    SELECT company_id INTO NEW.company_id FROM public.users WHERE id = NEW.user_id;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS audit_log_fill_company_id_trg ON public.audit_log;
CREATE TRIGGER audit_log_fill_company_id_trg
  BEFORE INSERT ON public.audit_log
  FOR EACH ROW
  EXECUTE FUNCTION public.audit_log_fill_company_id();
