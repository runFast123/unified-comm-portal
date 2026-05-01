// POST /api/conversations/[id]/merge-preview
//
// Body: { secondary_conversation_id: string }
//
// Returns a non-mutating preview of what would happen if the caller merged
// the body's secondary conversation into the URL's primary. Auth-gated:
// caller must have access to BOTH account_ids.

import { NextResponse } from 'next/server'
import {
  createServerSupabaseClient,
  createServiceRoleClient,
} from '@/lib/supabase-server'
import { verifyAccountAccess, checkRateLimit } from '@/lib/api-helpers'
import { previewMerge } from '@/lib/conversation-merge'

interface Body {
  secondary_conversation_id?: string
}

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const { id: primaryId } = await context.params
    if (!primaryId) {
      return NextResponse.json({ error: 'Missing conversation id' }, { status: 400 })
    }

    const supabase = await createServerSupabaseClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    if (!(await checkRateLimit(`merge-preview:${user.id}`, 60, 60))) {
      return NextResponse.json({ error: 'Rate limit exceeded' }, { status: 429 })
    }

    const body = (await request.json().catch(() => ({}))) as Body
    const secondaryId = typeof body.secondary_conversation_id === 'string'
      ? body.secondary_conversation_id
      : ''
    if (!secondaryId) {
      return NextResponse.json(
        { error: 'secondary_conversation_id is required' },
        { status: 400 }
      )
    }
    if (primaryId === secondaryId) {
      return NextResponse.json(
        { error: 'primary and secondary cannot be the same conversation' },
        { status: 400 }
      )
    }

    const admin = await createServiceRoleClient()

    // Look up both conversations to enforce access on each account_id.
    const { data: convs, error: convsErr } = await admin
      .from('conversations')
      .select('id, account_id')
      .in('id', [primaryId, secondaryId])
    if (convsErr) {
      return NextResponse.json({ error: convsErr.message }, { status: 500 })
    }
    if (!convs || convs.length !== 2) {
      return NextResponse.json({ error: 'Conversation not found' }, { status: 404 })
    }
    for (const c of convs) {
      const allowed = await verifyAccountAccess(user.id, c.account_id)
      if (!allowed) {
        return NextResponse.json(
          { error: 'Forbidden: account scope mismatch' },
          { status: 403 }
        )
      }
    }

    const preview = await previewMerge(admin, primaryId, secondaryId)
    if (!preview) {
      return NextResponse.json({ error: 'Conversation not found' }, { status: 404 })
    }
    return NextResponse.json({ preview })
  } catch (err) {
    console.error('merge-preview POST error:', err)
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Internal error' },
      { status: 500 }
    )
  }
}
