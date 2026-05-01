// GET /api/conversations/[id]/merge-candidates
//
// Returns up to 5 OTHER conversations that look like the same person
// (same email, phone, or contact_id) and aren't already merged. Used by
// the "Merge" UI in the conversation header.

import { NextResponse } from 'next/server'
import {
  createServerSupabaseClient,
  createServiceRoleClient,
} from '@/lib/supabase-server'
import { verifyAccountAccess, checkRateLimit } from '@/lib/api-helpers'
import { findMergeCandidates } from '@/lib/conversation-merge'
import { getAllowedAccountIds } from '@/lib/auth'

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await context.params
    if (!id) {
      return NextResponse.json({ error: 'Missing conversation id' }, { status: 400 })
    }

    const supabase = await createServerSupabaseClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }
    if (!(await checkRateLimit(`merge-candidates:${user.id}`, 60, 60))) {
      return NextResponse.json({ error: 'Rate limit exceeded' }, { status: 429 })
    }

    const admin = await createServiceRoleClient()
    const { data: source, error: srcErr } = await admin
      .from('conversations')
      .select('id, account_id')
      .eq('id', id)
      .maybeSingle()
    if (srcErr || !source) {
      return NextResponse.json({ error: 'Conversation not found' }, { status: 404 })
    }
    const allowed = await verifyAccountAccess(user.id, source.account_id)
    if (!allowed) {
      return NextResponse.json(
        { error: 'Forbidden: account scope mismatch' },
        { status: 403 }
      )
    }

    let candidates = await findMergeCandidates(admin, id, 5)

    // Final scope check: drop any candidate whose account_id the user can't see.
    // For super_admin (allowedIds === null) we keep everything.
    const allowedIds = await getAllowedAccountIds(user.id)
    if (allowedIds !== null) {
      // Need account_id per candidate to filter; refetch the slice.
      const candidateIds = candidates.map((c) => c.id)
      if (candidateIds.length > 0) {
        const { data: candAccounts } = await admin
          .from('conversations')
          .select('id, account_id')
          .in('id', candidateIds)
        const accountById = new Map<string, string>()
        for (const r of candAccounts ?? []) {
          accountById.set(
            (r as { id: string }).id,
            (r as { account_id: string }).account_id
          )
        }
        candidates = candidates.filter((c) => {
          const aid = accountById.get(c.id)
          return aid ? allowedIds.has(aid) : false
        })
      }
    }

    return NextResponse.json({ candidates })
  } catch (err) {
    console.error('merge-candidates GET error:', err)
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Internal error' },
      { status: 500 }
    )
  }
}
