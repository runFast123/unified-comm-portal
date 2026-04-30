import { NextResponse } from 'next/server'
import { createServerSupabaseClient, createServiceRoleClient } from '@/lib/supabase-server'

/**
 * GET /api/users/search?q=<prefix>
 *
 * Returns up to 10 users from the same company as the requesting user whose
 * `full_name` or `email` starts with `q` (case-insensitive). Used by the
 * @-mention autocomplete in internal notes.
 *
 * Auth: required. Results are scoped to the caller's company so we never leak
 * users across companies. Admins see everyone.
 *
 * Returns: `[{ id, full_name, email }]`
 */
export async function GET(request: Request) {
  const supabase = await createServerSupabaseClient()
  const {
    data: { user: authUser },
  } = await supabase.auth.getUser()
  if (!authUser) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const url = new URL(request.url)
  const rawQ = (url.searchParams.get('q') || '').trim()
  // Cap query length to avoid abuse — autocomplete only ever sends short strings.
  const q = rawQ.slice(0, 64)

  const admin = await createServiceRoleClient()

  // Look up the caller's role + account so we can compute company scope.
  const { data: me } = await admin
    .from('users')
    .select('role, account_id')
    .eq('id', authUser.id)
    .maybeSingle()

  if (!me) {
    return NextResponse.json({ error: 'User profile not found' }, { status: 404 })
  }

  // Build the prefix-match clause once; supabase-js doesn't allow leaving the
  // value empty, so empty `q` becomes "match anything".
  const escaped = q.replace(/[%_\\]/g, '\\$&')
  const ilikePattern = `${escaped}%`

  let query = admin
    .from('users')
    .select('id, full_name, email')
    .eq('is_active', true)
    .limit(10)

  if (q.length > 0) {
    query = query.or(`full_name.ilike.${ilikePattern},email.ilike.${ilikePattern}`)
  }

  // Scope by company unless the caller is an admin.
  if (me.role !== 'admin') {
    if (!me.account_id) {
      // Non-admin without an account — they can only see themselves.
      query = query.eq('id', authUser.id)
    } else {
      // Resolve the caller's company via their account, then collect every
      // sibling account in the same company. We fall back to the single
      // account_id if company_id is missing (legacy data).
      const { data: myAccount } = await admin
        .from('accounts')
        .select('id, company_id')
        .eq('id', me.account_id)
        .maybeSingle()

      if (myAccount?.company_id) {
        const { data: siblings } = await admin
          .from('accounts')
          .select('id')
          .eq('company_id', myAccount.company_id)
          .eq('is_active', true)
        const accountIds = (siblings || []).map((s) => s.id as string)
        if (accountIds.length === 0) {
          query = query.eq('id', authUser.id)
        } else {
          query = query.in('account_id', accountIds)
        }
      } else {
        query = query.eq('account_id', me.account_id)
      }
    }
  }

  const { data, error } = await query.order('full_name', { ascending: true })
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({
    users: (data || []).map((u) => ({
      id: u.id,
      full_name: u.full_name,
      email: u.email,
    })),
  })
}
