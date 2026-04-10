import { NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase-server'

/**
 * GET /api/user-accounts
 * Returns the sibling account IDs for the current authenticated user's company.
 * Used by the UserProvider to scope data across Email + Teams + WhatsApp channels.
 */
export async function GET() {
  try {
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

    if (!profile?.account_id || profile.role === 'admin') {
      return NextResponse.json({ accountIds: [], isAdmin: profile?.role === 'admin' })
    }

    // Get the user's account name
    const { data: myAccount } = await supabase
      .from('accounts')
      .select('name')
      .eq('id', profile.account_id)
      .maybeSingle()

    if (!myAccount?.name) {
      return NextResponse.json({ accountIds: [profile.account_id] })
    }

    // Find all sibling accounts with matching base name
    const baseName = myAccount.name
      .replace(/\s+Teams$/i, '')
      .replace(/\s+WhatsApp$/i, '')
      .trim()

    const { data: allAccounts } = await supabase
      .from('accounts')
      .select('id, name')
      .eq('is_active', true)

    if (!allAccounts) {
      return NextResponse.json({ accountIds: [profile.account_id] })
    }

    const siblingIds = allAccounts
      .filter(a => a.name.replace(/\s+Teams$/i, '').replace(/\s+WhatsApp$/i, '').trim() === baseName)
      .map(a => a.id)

    return NextResponse.json({ accountIds: siblingIds.length > 0 ? siblingIds : [profile.account_id] })
  } catch {
    return NextResponse.json({ accountIds: [] }, { status: 500 })
  }
}
