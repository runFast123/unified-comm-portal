/**
 * GET /api/conversations/[id]/timeline
 *
 * Returns the unified, chronologically-ordered activity feed for one
 * conversation: messages, AI drafts, status changes, snoozes, assignments,
 * notes, escalations — anything captured by the underlying audit trail.
 *
 * Backed by the `conversation_timeline(uuid)` Postgres function (see
 * migration 20260501000000_conversation_timeline_function.sql).
 *
 * Auth model:
 *   - Caller must be authenticated.
 *   - Caller must have access to the conversation's account
 *     (verifyAccountAccess — same gate the snooze endpoint uses).
 *   - super_admins bypass account scope.
 *
 * Response shape:
 *   { events: Array<{
 *       ts: string,            // ISO timestamp
 *       event_type: string,    // 'message_inbound' | 'message_outbound'
 *                              // | 'ai_draft' | 'conversation.snoozed'
 *                              // | 'conversation.unsnoozed'
 *                              // | 'conversation.status_changed'
 *                              // | 'conversation.assigned' | etc.
 *       actor_user_id: string | null,
 *       actor_label: string,   // e.g. 'Customer', 'AI', 'Aman', 'System'
 *       summary: string,
 *       details: Record<string, unknown>,
 *     }>
 *   }
 */

import { NextResponse } from 'next/server'

import { createServerSupabaseClient, createServiceRoleClient } from '@/lib/supabase-server'
import { verifyAccountAccess } from '@/lib/api-helpers'

export interface TimelineEvent {
  ts: string
  event_type: string
  actor_user_id: string | null
  actor_label: string
  summary: string
  details: Record<string, unknown> | null
}

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const { id: conversationId } = await context.params
    if (!conversationId) {
      return NextResponse.json({ error: 'Missing conversation id' }, { status: 400 })
    }

    const supabase = await createServerSupabaseClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const admin = await createServiceRoleClient()

    // Look up the conversation to scope-check before exposing its timeline.
    const { data: conv, error: convErr } = await admin
      .from('conversations')
      .select('id, account_id')
      .eq('id', conversationId)
      .maybeSingle()
    if (convErr || !conv) {
      return NextResponse.json({ error: 'Conversation not found' }, { status: 404 })
    }

    const allowed = await verifyAccountAccess(user.id, conv.account_id)
    if (!allowed) {
      return NextResponse.json({ error: 'Forbidden: account scope mismatch' }, { status: 403 })
    }

    const { data, error } = await admin.rpc('conversation_timeline', {
      p_conversation_id: conversationId,
    })

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    const events: TimelineEvent[] = (data ?? []).map((row: any) => ({
      ts: row.ts,
      event_type: row.event_type,
      actor_user_id: row.actor_user_id ?? null,
      actor_label: row.actor_label ?? 'System',
      summary: row.summary ?? '',
      details: (row.details ?? null) as Record<string, unknown> | null,
    }))

    return NextResponse.json({ events })
  } catch (err) {
    console.error('Timeline GET error:', err)
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Internal error' },
      { status: 500 }
    )
  }
}
