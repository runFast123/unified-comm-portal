-- ============================================================================
-- Introduce a proper `companies` table + `accounts.company_id` FK so that
-- multi-channel grouping ("Acme Teams" + "Acme WhatsApp" belong to the same
-- tenant) is no longer a string-substring heuristic over account names.
--
-- Why: the previous logic in src/lib/api-helpers.ts `verifyAccountAccess`
-- (and the layout / user-accounts route) grouped sibling accounts by
-- stripping " Teams"/" WhatsApp" from `accounts.name`. That:
--   * silently breaks if an admin renames "Acme Teams" -> "Acme Inc Teams"
--   * leaks data between two unrelated tenants both literally called
--     "Support Teams"
--   * makes an authz boundary depend on a string heuristic
--
-- The migration:
--   1) creates `public.companies` (id, name UNIQUE)
--   2) adds `accounts.company_id` FK + index
--   3) backfills every existing account by deriving a company name from the
--      current trailing-channel suffix, upserting into companies, and linking
--      the FK. Behavior is preserved: anything the old name-strip considered
--      siblings now share a company_id.
-- ============================================================================

-- 1) companies table
CREATE TABLE IF NOT EXISTS public.companies (
  id   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.companies ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Authenticated read companies" ON public.companies;
CREATE POLICY "Authenticated read companies"
  ON public.companies FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS "Admins write companies" ON public.companies;
CREATE POLICY "Admins write companies"
  ON public.companies FOR ALL TO authenticated USING (is_admin()) WITH CHECK (is_admin());

-- 2) FK on accounts
ALTER TABLE public.accounts
  ADD COLUMN IF NOT EXISTS company_id uuid REFERENCES public.companies(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_accounts_company_id ON public.accounts(company_id);

-- 3) Backfill: for every existing account, derive a company name by stripping
--    the trailing channel suffix ("Acme Teams" -> "Acme"), upsert into companies,
--    and link the FK. This keeps the current grouping behavior intact.
DO $$
DECLARE
  acc record;
  base_name text;
  cid uuid;
BEGIN
  FOR acc IN SELECT id, name FROM public.accounts WHERE company_id IS NULL LOOP
    base_name := regexp_replace(acc.name, '\s+(Teams|WhatsApp|Email)$', '', 'i');
    base_name := trim(base_name);
    IF base_name = '' THEN base_name := acc.name; END IF;

    INSERT INTO public.companies (name) VALUES (base_name)
    ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name
    RETURNING id INTO cid;

    UPDATE public.accounts SET company_id = cid WHERE id = acc.id;
  END LOOP;
END $$;
