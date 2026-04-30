-- ============================================================================
-- Multi-tenancy foundation
-- Idempotent: safe to re-run.
--
-- 1) Extend `companies` with branding + AI budget rollup + slug + settings.
-- 2) Backfill any account that's still missing a company_id (handles names
--    using either a SPACE or UNDERSCORE separator, e.g. "MCM Teams" or
--    "MCM_Teams").
-- 3) Add a denormalized `users.company_id` + trigger to keep it in sync with
--    `users.account_id` so RLS can scope quickly without a 3-way join.
-- 4) Extend the `user_role` enum with `super_admin`, `company_admin`,
--    `company_member` (existing 'admin' is preserved for back-compat — it
--    behaves as a company-scoped admin going forward; super_admin is the
--    cross-tenant escape hatch).
--
-- Helper functions and RLS policies are added in the companion migration
-- 20260430150100_multi_tenancy_helpers_and_rls.sql — split because
-- `ALTER TYPE ... ADD VALUE` cannot be committed in the same transaction
-- as functions / RLS policies that reference the new value.
-- ============================================================================

-- Extend companies with branding + AI budget rollup.
ALTER TABLE public.companies
  ADD COLUMN IF NOT EXISTS slug text,
  ADD COLUMN IF NOT EXISTS logo_url text,
  ADD COLUMN IF NOT EXISTS accent_color text,
  ADD COLUMN IF NOT EXISTS monthly_ai_budget_usd numeric,
  ADD COLUMN IF NOT EXISTS settings jsonb DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS updated_at timestamptz DEFAULT now();

CREATE UNIQUE INDEX IF NOT EXISTS uniq_companies_slug
  ON public.companies (slug) WHERE slug IS NOT NULL;

-- Auto-update updated_at on companies row changes.
CREATE OR REPLACE FUNCTION public.touch_companies_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS companies_touch_updated_at ON public.companies;
CREATE TRIGGER companies_touch_updated_at
  BEFORE UPDATE ON public.companies
  FOR EACH ROW EXECUTE FUNCTION public.touch_companies_updated_at();

-- Ensure at least one company exists for legacy data with no accounts.
INSERT INTO public.companies (id, name)
SELECT gen_random_uuid(), 'Default Company'
WHERE NOT EXISTS (SELECT 1 FROM public.companies LIMIT 1);

-- Backfill: every account without a company gets one based on its base name
-- (strip trailing " Teams"/" WhatsApp"/"_Teams"/"_WhatsApp"/" Email" suffixes).
DO $$
DECLARE
  acc RECORD;
  base_name text;
  comp_id uuid;
BEGIN
  FOR acc IN SELECT id, name FROM public.accounts WHERE company_id IS NULL LOOP
    base_name := acc.name;
    base_name := regexp_replace(base_name, '[\s_]+(Teams|WhatsApp|Email)$', '', 'i');
    base_name := trim(base_name);
    IF base_name = '' OR base_name IS NULL THEN
      base_name := acc.name;
    END IF;

    SELECT id INTO comp_id FROM public.companies WHERE name = base_name LIMIT 1;
    IF comp_id IS NULL THEN
      INSERT INTO public.companies (name) VALUES (base_name)
      ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name
      RETURNING id INTO comp_id;
    END IF;

    UPDATE public.accounts SET company_id = comp_id WHERE id = acc.id;
  END LOOP;
END $$;

-- Add company_id directly on users (denormalized for fast RLS).
ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS company_id uuid REFERENCES public.companies(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_users_company_id ON public.users(company_id);

-- Backfill users.company_id from their account.
UPDATE public.users u
SET company_id = a.company_id
FROM public.accounts a
WHERE u.account_id = a.id AND u.company_id IS NULL;

-- Trigger to keep users.company_id in sync if account_id changes.
CREATE OR REPLACE FUNCTION public.sync_user_company_id() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.account_id IS NOT NULL THEN
    SELECT company_id INTO NEW.company_id FROM public.accounts WHERE id = NEW.account_id;
  ELSE
    -- Detached from account: drop company_id too unless it was set explicitly.
    IF TG_OP = 'UPDATE' AND OLD.account_id IS NOT NULL AND NEW.company_id = OLD.company_id THEN
      NEW.company_id := NULL;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS users_sync_company_id ON public.users;
CREATE TRIGGER users_sync_company_id
  BEFORE INSERT OR UPDATE OF account_id ON public.users
  FOR EACH ROW EXECUTE FUNCTION public.sync_user_company_id();

-- Extend user_role enum with super_admin, company_admin, company_member.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_enum e ON e.enumtypid=t.oid
                 WHERE t.typname='user_role' AND e.enumlabel='super_admin') THEN
    ALTER TYPE public.user_role ADD VALUE 'super_admin';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_enum e ON e.enumtypid=t.oid
                 WHERE t.typname='user_role' AND e.enumlabel='company_admin') THEN
    ALTER TYPE public.user_role ADD VALUE 'company_admin';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_enum e ON e.enumtypid=t.oid
                 WHERE t.typname='user_role' AND e.enumlabel='company_member') THEN
    ALTER TYPE public.user_role ADD VALUE 'company_member';
  END IF;
END $$;
