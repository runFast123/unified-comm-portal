-- ============================================================================
-- Conversation merging (soft merge).
--
-- When the same person reaches out from multiple addresses or channels we let
-- agents collapse two conversations into one. The "secondary" conversation is
-- not deleted: its row stays for audit, but its messages are re-pointed at the
-- "primary" conversation and its `merged_into_id` is set so the inbox can hide
-- it from the unified list.
--
-- An audit row in conversation_merges captures the exact set of message ids
-- that were moved, so unmerge can reverse the operation deterministically.
--
-- Idempotent — safe to re-run.
-- ============================================================================

ALTER TABLE public.conversations
  ADD COLUMN IF NOT EXISTS merged_into_id uuid REFERENCES public.conversations(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS merged_at timestamptz,
  ADD COLUMN IF NOT EXISTS merged_by uuid REFERENCES auth.users(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_conversations_merged_into
  ON public.conversations (merged_into_id);

-- Audit trail: every merge captures the message ids that were moved so that
-- unmerge can reverse the operation deterministically.
CREATE TABLE IF NOT EXISTS public.conversation_merges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  primary_conversation_id uuid NOT NULL REFERENCES public.conversations(id) ON DELETE CASCADE,
  secondary_conversation_id uuid NOT NULL REFERENCES public.conversations(id) ON DELETE CASCADE,
  message_ids uuid[] NOT NULL,
  merged_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  merged_at timestamptz NOT NULL DEFAULT now(),
  unmerged_at timestamptz,
  unmerged_by uuid REFERENCES auth.users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_conversation_merges_primary
  ON public.conversation_merges (primary_conversation_id);

CREATE INDEX IF NOT EXISTS idx_conversation_merges_secondary
  ON public.conversation_merges (secondary_conversation_id);

ALTER TABLE public.conversation_merges ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "merges_read_company" ON public.conversation_merges;
CREATE POLICY "merges_read_company" ON public.conversation_merges
  FOR SELECT TO authenticated USING (
    is_super_admin() OR
    primary_conversation_id IN (
      SELECT id FROM public.conversations WHERE account_id IN (
        SELECT id FROM public.accounts WHERE company_id = current_user_company_id()
      )
    )
  );

-- ============================================================================
-- Atomic merge / unmerge RPCs.
--
-- These are SECURITY DEFINER so they run as the table owner and can perform
-- the multi-statement merge inside a single transaction (PostgREST wraps the
-- call in BEGIN/COMMIT). Auth + scoping is enforced by the calling Next.js
-- route; the function only validates structural invariants (no self-merge,
-- no double-merge, both rows exist, both belong to the same account or
-- accounts in the same company).
-- ============================================================================

CREATE OR REPLACE FUNCTION public.merge_conversations(
  p_primary_id uuid,
  p_secondary_id uuid,
  p_user_id uuid
) RETURNS public.conversation_merges
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_primary public.conversations%ROWTYPE;
  v_secondary public.conversations%ROWTYPE;
  v_message_ids uuid[];
  v_audit public.conversation_merges%ROWTYPE;
  v_primary_company uuid;
  v_secondary_company uuid;
  v_new_last_message_at timestamptz;
BEGIN
  IF p_primary_id IS NULL OR p_secondary_id IS NULL THEN
    RAISE EXCEPTION 'merge_conversations: ids must not be null';
  END IF;
  IF p_primary_id = p_secondary_id THEN
    RAISE EXCEPTION 'merge_conversations: primary and secondary cannot be the same conversation';
  END IF;

  SELECT * INTO v_primary FROM public.conversations WHERE id = p_primary_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'merge_conversations: primary conversation % not found', p_primary_id;
  END IF;
  SELECT * INTO v_secondary FROM public.conversations WHERE id = p_secondary_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'merge_conversations: secondary conversation % not found', p_secondary_id;
  END IF;

  IF v_primary.merged_into_id IS NOT NULL THEN
    RAISE EXCEPTION 'merge_conversations: primary % is already merged into another conversation', p_primary_id;
  END IF;
  IF v_secondary.merged_into_id IS NOT NULL THEN
    RAISE EXCEPTION 'merge_conversations: secondary % is already merged', p_secondary_id;
  END IF;

  -- Same company guard: look up each account's company_id and require equality
  -- (or both null, for legacy rows). Account-id equality is allowed too.
  SELECT company_id INTO v_primary_company FROM public.accounts WHERE id = v_primary.account_id;
  SELECT company_id INTO v_secondary_company FROM public.accounts WHERE id = v_secondary.account_id;
  IF v_primary.account_id <> v_secondary.account_id
     AND COALESCE(v_primary_company::text, '') <> COALESCE(v_secondary_company::text, '') THEN
    RAISE EXCEPTION 'merge_conversations: conversations belong to different companies';
  END IF;

  -- Re-point the secondary's messages onto the primary in a single CTE so we
  -- get the moved-id list in one round-trip.
  WITH moved AS (
    UPDATE public.messages
       SET conversation_id = p_primary_id
     WHERE conversation_id = p_secondary_id
     RETURNING id
  )
  SELECT COALESCE(array_agg(id), ARRAY[]::uuid[]) INTO v_message_ids FROM moved;

  -- Stamp the secondary conversation as merged.
  UPDATE public.conversations
     SET merged_into_id = p_primary_id,
         merged_at      = now(),
         merged_by      = p_user_id
   WHERE id = p_secondary_id;

  -- Roll the primary's last_message_at forward if the secondary was newer.
  v_new_last_message_at := GREATEST(
    COALESCE(v_primary.last_message_at,   v_secondary.last_message_at),
    COALESCE(v_secondary.last_message_at, v_primary.last_message_at)
  );
  IF v_new_last_message_at IS NOT NULL
     AND v_new_last_message_at IS DISTINCT FROM v_primary.last_message_at THEN
    UPDATE public.conversations
       SET last_message_at = v_new_last_message_at
     WHERE id = p_primary_id;
  END IF;

  -- Audit row.
  INSERT INTO public.conversation_merges (
    primary_conversation_id, secondary_conversation_id, message_ids, merged_by
  ) VALUES (
    p_primary_id, p_secondary_id, v_message_ids, p_user_id
  ) RETURNING * INTO v_audit;

  RETURN v_audit;
END;
$$;

GRANT EXECUTE ON FUNCTION public.merge_conversations(uuid, uuid, uuid) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.unmerge_conversations(
  p_primary_id uuid,
  p_secondary_id uuid,
  p_user_id uuid
) RETURNS public.conversation_merges
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_audit public.conversation_merges%ROWTYPE;
  v_secondary public.conversations%ROWTYPE;
BEGIN
  IF p_primary_id IS NULL OR p_secondary_id IS NULL THEN
    RAISE EXCEPTION 'unmerge_conversations: ids must not be null';
  END IF;

  -- Look up the most recent active (not-yet-unmerged) audit row.
  SELECT * INTO v_audit
    FROM public.conversation_merges
   WHERE primary_conversation_id = p_primary_id
     AND secondary_conversation_id = p_secondary_id
     AND unmerged_at IS NULL
   ORDER BY merged_at DESC
   LIMIT 1
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'unmerge_conversations: no active merge found between % and %', p_primary_id, p_secondary_id;
  END IF;

  SELECT * INTO v_secondary FROM public.conversations WHERE id = p_secondary_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'unmerge_conversations: secondary conversation % no longer exists', p_secondary_id;
  END IF;

  -- Move only the message ids we recorded — newer messages on the primary
  -- (e.g. agent replies after the merge) stay on the primary.
  IF array_length(v_audit.message_ids, 1) IS NOT NULL THEN
    UPDATE public.messages
       SET conversation_id = p_secondary_id
     WHERE id = ANY (v_audit.message_ids)
       AND conversation_id = p_primary_id;
  END IF;

  -- Clear the merge marker on the secondary.
  UPDATE public.conversations
     SET merged_into_id = NULL,
         merged_at      = NULL,
         merged_by      = NULL
   WHERE id = p_secondary_id;

  -- Stamp the audit row.
  UPDATE public.conversation_merges
     SET unmerged_at = now(),
         unmerged_by = p_user_id
   WHERE id = v_audit.id
   RETURNING * INTO v_audit;

  RETURN v_audit;
END;
$$;

GRANT EXECUTE ON FUNCTION public.unmerge_conversations(uuid, uuid, uuid) TO authenticated, service_role;
