import { NextResponse } from 'next/server'
import { createServerSupabaseClient, createServiceRoleClient } from '@/lib/supabase-server'

/**
 * GET /api/user-accounts
 * Returns the sibling account IDs for the current authenticated user's company.
 *
 * New behavior: groups via `accounts.company_id` (the proper FK) instead of
 * the brittle name-substring match. Falls back to name-stripping with a
 * `console.warn` only if the user's row hasn't been backfilled.
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
      .select('role, account_id')
      .eq('id', user.id)
      .maybeSingle()

    // Admins (or users with no account) get the admin-style empty payload.
    if (!profile?.account_id || profile.role === 'admin') {
      return NextResponse.json({ accountIds: [], isAdmin: profile?.role === 'admin' })
    }

    // Use service role to bypass RLS so we can resolve the user's siblings
    // even when their RLS policy hides other-channel rows.
    const service = await createServiceRoleClient()

    const { data: myAccount } = await service
      .from('accounts')
      .select('id, name, company_id')
      .eq('id', profile.account_id)
      .maybeSingle()

    if (!myAccount) {
      return NextResponse.json({ accountIds: [profile.account_id] })
    }

    // Happy path: company_id present → simple FK query.
    if (myAccount.company_id) {
      const { data: siblings } = await service
        .from('accounts')
        .select('*')
        .eq('company_id', myAccount.company_id)
        .eq('is_active', true)
        .order('name')

      const ids = (siblings ?? []).map((a) => a.id as string)
      return NextResponse.json({
        accountIds: ids.length > 0 ? ids : [profile.account_id],
        accounts: siblings ?? [],
      })
    }

    // Legacy fallback — user's account has no company_id yet. Warn and fall
    // back to the old name-substring heuristic so we don't break legacy users.
    console.warn(
      `[user-accounts] Falling back to name-substring match — account ${profile.account_id} ` +
        `has no company_id. Run/verify the companies backfill migration.`
    )

    const { data: allAccounts } = await service
      .from('accounts')
      .select('*')
      .eq('is_active', true)
      .order('name')

    if (!allAccounts) {
      return NextResponse.json({ accountIds: [profile.account_id] })
    }

    const stripChannelSuffix = (n: string) =>
      n.replace(/\s+Teams$/i, '').replace(/\s+WhatsApp$/i, '').trim()
    const baseName = stripChannelSuffix(myAccount.name as string)

    const siblingAccounts = allAccounts.filter(
      (a) => stripChannelSuffix(a.name as string) === baseName
    )
    const siblingIds = siblingAccounts.map((a) => a.id as string)

    return NextResponse.json({
      accountIds: siblingIds.length > 0 ? siblingIds : [profile.account_id],
      accounts: siblingAccounts,
    })
  } catch (err) {
    console.error('[user-accounts] Error:', err)
    return NextResponse.json({ accountIds: [] }, { status: 500 })
  }
}
