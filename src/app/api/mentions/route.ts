import { NextResponse } from 'next/server'
import { createServerSupabaseClient, createServiceRoleClient } from '@/lib/supabase-server'

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000

/**
 * GET /api/mentions
 *
 * Lists the current user's mentions from the last 30 days. Unread first
 * (sorted newest-first), then read (sorted newest-first). Hard-capped at 50.
 */
export async function GET() {
  const supabase = await createServerSupabaseClient()
  const {
    data: { user: authUser },
  } = await supabase.auth.getUser()
  if (!authUser) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const admin = await createServiceRoleClient()
  const since = new Date(Date.now() - THIRTY_DAYS_MS).toISOString()

  const { data, error } = await admin
    .from('note_mentions')
    .select(
      'id, note_id, conversation_id, read_at, created_at, conversation_notes!inner(note_text, author_name)'
    )
    .eq('mentioned_user_id', authUser.id)
    .gte('created_at', since)
    .order('created_at', { ascending: false })
    .limit(50)

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  type MentionRow = {
    id: string
    note_id: string
    conversation_id: string
    read_at: string | null
    created_at: string
    conversation_notes:
      | { note_text: string | null; author_name: string | null }
      | { note_text: string | null; author_name: string | null }[]
      | null
  }

  const mentions = ((data as MentionRow[] | null) || []).map((row) => {
    const note = Array.isArray(row.conversation_notes)
      ? row.conversation_notes[0]
      : row.conversation_notes
    return {
      id: row.id,
      note_id: row.note_id,
      conversation_id: row.conversation_id,
      read_at: row.read_at,
      created_at: row.created_at,
      note_preview: (note?.note_text || '').slice(0, 200),
      author_name: note?.author_name || null,
    }
  })

  // Unread first, then read — both already sorted by created_at desc.
  mentions.sort((a, b) => {
    const aUnread = a.read_at == null ? 0 : 1
    const bUnread = b.read_at == null ? 0 : 1
    if (aUnread !== bUnread) return aUnread - bUnread
    return new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
  })

  const unread_count = mentions.filter((m) => m.read_at == null).length

  return NextResponse.json({ mentions, unread_count })
}

/**
 * PATCH /api/mentions?id=<mention_id>
 *
 * Marks the mention as read (sets `read_at = now()`). Idempotent.
 */
export async function PATCH(request: Request) {
  const supabase = await createServerSupabaseClient()
  const {
    data: { user: authUser },
  } = await supabase.auth.getUser()
  if (!authUser) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const url = new URL(request.url)
  const id = url.searchParams.get('id')
  if (!id) {
    return NextResponse.json({ error: 'id query param required' }, { status: 400 })
  }

  const admin = await createServiceRoleClient()
  // Only update if the mention belongs to the caller — the service-role client
  // bypasses RLS, so we enforce ownership here.
  const { data: target, error: lookupErr } = await admin
    .from('note_mentions')
    .select('id, mentioned_user_id, read_at')
    .eq('id', id)
    .maybeSingle()
  if (lookupErr) {
    return NextResponse.json({ error: lookupErr.message }, { status: 500 })
  }
  if (!target) {
    return NextResponse.json({ error: 'Mention not found' }, { status: 404 })
  }
  if (target.mentioned_user_id !== authUser.id) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }
  if (target.read_at) {
    return NextResponse.json({ success: true, read_at: target.read_at, noop: true })
  }

  const readAt = new Date().toISOString()
  const { error: updateErr } = await admin
    .from('note_mentions')
    .update({ read_at: readAt })
    .eq('id', id)
  if (updateErr) {
    return NextResponse.json({ error: updateErr.message }, { status: 500 })
  }

  return NextResponse.json({ success: true, read_at: readAt })
}
