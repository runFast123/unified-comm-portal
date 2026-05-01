-- ============================================================================
-- Per-account Out-of-Office (OOO) auto-replies.
-- Idempotent: safe to re-run.
--
-- Adds five OOO config columns to accounts and a dedup table that records
-- which conversations have already received an auto-reply during a given
-- OOO window so we don't keep auto-replying to every follow-up email.
-- ============================================================================

ALTER TABLE public.accounts
  ADD COLUMN IF NOT EXISTS ooo_enabled boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS ooo_starts_at timestamptz,
  ADD COLUMN IF NOT EXISTS ooo_ends_at timestamptz,
  ADD COLUMN IF NOT EXISTS ooo_subject text DEFAULT 'Out of office',
  ADD COLUMN IF NOT EXISTS ooo_body text;

-- Track which conversations have already received an OOO auto-reply during
-- a given OOO window — so we don't keep auto-replying every time the same
-- person sends another email.
CREATE TABLE IF NOT EXISTS public.ooo_replies_sent (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL REFERENCES public.conversations(id) ON DELETE CASCADE,
  ooo_window_start timestamptz NOT NULL,
  sent_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_ooo_per_conv_per_window
  ON public.ooo_replies_sent (conversation_id, ooo_window_start);

CREATE INDEX IF NOT EXISTS idx_ooo_replies_account
  ON public.ooo_replies_sent (account_id);

ALTER TABLE public.ooo_replies_sent ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "OOO read company" ON public.ooo_replies_sent;
CREATE POLICY "OOO read company" ON public.ooo_replies_sent
  FOR SELECT TO authenticated USING (
    public.is_super_admin() OR
    account_id IN (SELECT id FROM public.accounts WHERE company_id = public.current_user_company_id())
  );
