import { NextResponse } from 'next/server'
import { createServerSupabaseClient, createServiceRoleClient } from '@/lib/supabase-server'
import { isSuperAdmin } from '@/lib/auth'

/**
 * GET /api/user-accounts
 * Returns the sibling account IDs for the current authenticated user's company.
 *
 * Groups via `accounts.company_id` (the proper FK). The old name-substring
 * fallback is gone — every account has a company_id post-migration. If a row
 * is somehow missing one, the user just sees only their own account, which
 * is the safe deny-by-default outcome.
 */
export async function GET() {
  try {
    // Authenticate user via session
    const supabase = await createServerSupabaseClient()
    const { data: { user } } = await supabase.auth.getUser()

    if (!user) {
      return NextResponse.json({ accountIds: [] }, { status: 401 })
    }

    // Get user profile
    const { data: profile } = await supabase
      .from('users')
      .select('role, account_id, company_id')
      .eq('id', user.id)
      .maybeSingle()

    // super_admin gets the admin-style empty payload (cross-tenant — UI shows
    // all accounts and queries are not scoped). Legacy 'admin' on a row with
    // no company is also treated this way for back-compat.
    if (isSuperAdmin(profile?.role) || (!profile?.account_id && !profile?.company_id)) {
      return NextResponse.json({
        accountIds: [],
        isAdmin: !!profile?.role && (profile.role === 'super_admin' || profile.role === 'admin'),
      })
    }

    const service = await createServiceRoleClient()

    if (profile?.company_id) {
      const { data: siblings } = await service
        .from('accounts')
        .select('*')
        .eq('company_id', profile.company_id)
        .eq('is_active', true)
        .order('name')

      const ids = (siblings ?? []).map((a) => a.id as string)
      return NextResponse.json({
        accountIds: ids.length > 0 ? ids : (profile.account_id ? [profile.account_id] : []),
        accounts: siblings ?? [],
      })
    }

    // No company — fall back to the user's single account if any.
    return NextResponse.json({
      accountIds: profile?.account_id ? [profile.account_id] : [],
      accounts: [],
    })
  } catch (err) {
    console.error('[user-accounts] Error:', err)
    return NextResponse.json({ accountIds: [] }, { status: 500 })
  }
}
