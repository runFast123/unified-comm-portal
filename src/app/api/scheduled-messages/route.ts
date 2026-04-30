import { NextResponse } from 'next/server'
import { createServerSupabaseClient, createServiceRoleClient } from '@/lib/supabase-server'
import { checkRateLimit } from '@/lib/api-helpers'

// Reject anything scheduled more than a year out. Keeps runaway/malicious
// payloads from squatting on the scheduled-messages table forever.
const MAX_SCHEDULE_HORIZON_MS = 365 * 24 * 60 * 60 * 1000

type Channel = 'email' | 'teams' | 'whatsapp'

interface CreateBody {
  conversation_id: string
  channel: Channel
  reply_text: string
  to?: string | null
  subject?: string | null
  teams_chat_id?: string | null
  scheduled_for: string
  attachments?: unknown
}

/**
 * POST /api/scheduled-messages
 * Creates a scheduled message that the cron dispatcher will send at `scheduled_for`.
 *
 * Security: session-auth + account scope. Admins can schedule on any account; other
 * users must match the conversation's account_id (mirrors /api/send's pattern).
 */
export async function POST(request: Request) {
  try {
    const supabase = await createServerSupabaseClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    // Rate limit: 50 scheduled messages per 5 minutes per user. Cheap to
    // enforce and blunts abuse even though the auth check above already
    // requires a valid session.
    if (!(await checkRateLimit(`scheduled:create:${user.id}`, 50, 300))) {
      return NextResponse.json({ error: 'Rate limit exceeded' }, { status: 429 })
    }

    const body = (await request.json()) as CreateBody
    const { conversation_id, channel, reply_text, scheduled_for } = body

    if (!conversation_id || !channel || !reply_text || !scheduled_for) {
      return NextResponse.json({ error: 'Missing required fields' }, { status: 400 })
    }
    if (!(['email', 'teams', 'whatsapp'] as const).includes(channel)) {
      return NextResponse.json({ error: `Unsupported channel: ${channel}` }, { status: 400 })
    }

    const scheduledAt = new Date(scheduled_for)
    if (Number.isNaN(scheduledAt.getTime())) {
      return NextResponse.json({ error: 'Invalid scheduled_for (must be ISO datetime)' }, { status: 400 })
    }
    // Must be in the future. One-minute floor guards clock skew and misclicks.
    if (scheduledAt.getTime() <= Date.now()) {
      return NextResponse.json({ error: 'scheduled_for must be in the future' }, { status: 400 })
    }
    // Upper bound: reject anything more than a year out.
    if (scheduledAt.getTime() > Date.now() + MAX_SCHEDULE_HORIZON_MS) {
      return NextResponse.json(
        { error: 'scheduled_for must be within 365 days' },
        { status: 400 }
      )
    }

    const admin = await createServiceRoleClient()

    // Account scope: admin or same account_id as the conversation.
    const { data: profile } = await admin
      .from('users')
      .select('role, account_id')
      .eq('id', user.id)
      .maybeSingle()
    if (!profile) return NextResponse.json({ error: 'User profile not found' }, { status: 403 })
    const isAdmin = profile.role === 'admin'

    const { data: conv } = await admin
      .from('conversations')
      .select('id, account_id, channel')
      .eq('id', conversation_id)
      .maybeSingle()
    if (!conv) return NextResponse.json({ error: 'Conversation not found' }, { status: 404 })
    if (!isAdmin && profile.account_id !== conv.account_id) {
      return NextResponse.json({ error: 'Forbidden: account scope mismatch' }, { status: 403 })
    }
    if (conv.channel !== channel) {
      return NextResponse.json({ error: 'Channel mismatch with conversation' }, { status: 400 })
    }

    // Channel-specific recipient validation.
    if (channel === 'email' && !body.to) {
      return NextResponse.json({ error: 'Missing recipient email (to)' }, { status: 400 })
    }
    if (channel === 'teams' && !body.teams_chat_id) {
      return NextResponse.json({ error: 'Missing teams_chat_id' }, { status: 400 })
    }
    if (channel === 'whatsapp' && !body.to) {
      return NextResponse.json({ error: 'Missing recipient phone (to)' }, { status: 400 })
    }

    const { data: row, error } = await admin
      .from('scheduled_messages')
      .insert({
        conversation_id,
        account_id: conv.account_id,
        channel,
        reply_text,
        to_address: body.to ?? null,
        subject: body.subject ?? null,
        teams_chat_id: body.teams_chat_id ?? null,
        attachments: body.attachments ?? null,
        scheduled_for: scheduledAt.toISOString(),
        status: 'pending',
        created_by: user.id,
      })
      .select('*')
      .single()

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    return NextResponse.json({ success: true, scheduled: row })
  } catch (err) {
    console.error('Scheduled-messages POST error:', err)
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Internal error' },
      { status: 500 }
    )
  }
}

/**
 * GET /api/scheduled-messages
 * Returns pending scheduled messages the caller can see. Admins see all; regular
 * users see their own account. Optional ?conversation_id=... filter.
 */
export async function GET(request: Request) {
  try {
    const supabase = await createServerSupabaseClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const admin = await createServiceRoleClient()
    const { data: profile } = await admin
      .from('users')
      .select('role, account_id')
      .eq('id', user.id)
      .maybeSingle()
    if (!profile) return NextResponse.json({ error: 'User profile not found' }, { status: 403 })
    const isAdmin = profile.role === 'admin'

    const url = new URL(request.url)
    const conversationId = url.searchParams.get('conversation_id')

    let query = admin
      .from('scheduled_messages')
      .select('*')
      .eq('status', 'pending')
      .order('scheduled_for', { ascending: true })

    if (!isAdmin) {
      if (!profile.account_id) return NextResponse.json({ items: [] })
      query = query.eq('account_id', profile.account_id)
    }
    if (conversationId) {
      query = query.eq('conversation_id', conversationId)
    }

    const { data, error } = await query
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })

    return NextResponse.json({ items: data ?? [] })
  } catch (err) {
    console.error('Scheduled-messages GET error:', err)
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Internal error' },
      { status: 500 }
    )
  }
}
