-- ============================================================================
-- conversation_timeline(p_conversation_id uuid)
--
-- Unified read view that JOINs every event source for a single conversation
-- into a single chronological feed:
--
--   * messages              → inbound / outbound message events
--   * ai_replies            → "AI drafted a reply" events
--   * audit_log             → status changes, snoozes, assignments, notes,
--                             escalations, etc. (anything written via
--                             logAudit() or direct insert with
--                             entity_type = 'conversation')
--
-- Returns one row per event, ordered ts ASC. The UI (activity timeline
-- component) consumes this directly and decides icon/color/copy based on
-- `event_type`.
--
-- Function form (vs materialized view) chosen because:
--   * No REFRESH planning — always live.
--   * Per-conversation lookup is cheap (~tens to hundreds of rows).
--   * SECURITY DEFINER + EXECUTE grant on `authenticated` lets RLS on the
--     underlying tables continue to filter what users can see — but read
--     access is intentionally permissive here because the API route in
--     /api/conversations/[id]/timeline performs the account-scope check
--     before invoking this function.
--
-- Idempotent: CREATE OR REPLACE.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.conversation_timeline(p_conversation_id uuid)
RETURNS TABLE (
  ts            timestamptz,
  event_type    text,
  actor_user_id uuid,
  actor_label   text,
  summary       text,
  details       jsonb
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  -- Messages
  SELECT
    m.timestamp AS ts,
    CASE WHEN m.direction = 'inbound' THEN 'message_inbound' ELSE 'message_outbound' END AS event_type,
    NULL::uuid AS actor_user_id,
    CASE
      WHEN m.sender_type = 'ai' THEN 'AI'
      WHEN m.sender_type = 'agent' THEN COALESCE(m.sender_name, 'Agent')
      ELSE COALESCE(m.sender_name, 'Customer')
    END AS actor_label,
    LEFT(COALESCE(m.message_text, m.email_subject, ''), 200) AS summary,
    jsonb_build_object(
      'message_id', m.id,
      'channel', m.channel,
      'is_spam', m.is_spam,
      'sender_type', m.sender_type
    ) AS details
  FROM public.messages m
  WHERE m.conversation_id = p_conversation_id

  UNION ALL

  -- AI drafts
  SELECT
    ar.created_at,
    'ai_draft',
    NULL::uuid,
    'AI',
    'Drafted reply (status: ' || ar.status || ')',
    jsonb_build_object('ai_reply_id', ar.id, 'status', ar.status, 'confidence', ar.confidence_score)
  FROM public.ai_replies ar
  WHERE ar.conversation_id = p_conversation_id

  UNION ALL

  -- Audit log scoped to this conversation. The `action` is used directly as
  -- the event_type so the UI can render any new audited action without a
  -- function migration. Examples already in use:
  --   conversation.snoozed, conversation.unsnoozed,
  --   conversation.status_changed, conversation.assigned,
  --   conversation.note_added, conversation.escalated, conversation.merged
  SELECT
    al.created_at,
    al.action,
    al.user_id,
    COALESCE(
      (SELECT full_name FROM public.users WHERE id = al.user_id),
      'System'
    ),
    LEFT(COALESCE(al.details->>'summary', al.action), 200),
    al.details
  FROM public.audit_log al
  WHERE al.entity_type = 'conversation' AND al.entity_id = p_conversation_id

  ORDER BY ts ASC;
$$;

GRANT EXECUTE ON FUNCTION public.conversation_timeline(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.conversation_timeline(uuid) TO anon;
GRANT EXECUTE ON FUNCTION public.conversation_timeline(uuid) TO service_role;
