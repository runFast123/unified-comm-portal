import { NextResponse } from 'next/server'
import { createServerSupabaseClient, createServiceRoleClient } from '@/lib/supabase-server'

/**
 * GET /api/onboarding/status
 *
 * Admin-only. Returns the completion state of the 4 onboarding steps.
 * Each boolean is derived via a parallel DB query using the service-role client.
 */
export async function GET() {
  // Session check — must be logged in
  const supabase = await createServerSupabaseClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // Role check — admin only
  const admin = await createServiceRoleClient()
  const { data: profile } = await admin
    .from('users')
    .select('role')
    .eq('id', user.id)
    .maybeSingle()

  if (profile?.role !== 'admin') {
    return NextResponse.json({ error: 'Admin only' }, { status: 403 })
  }

  // Run all four detection queries in parallel
  const [accountsRes, credsRes, usersRes, outboundRes] = await Promise.all([
    // 1. Any account row exists
    admin.from('accounts').select('id', { count: 'exact', head: true }).limit(1),

    // 2. Any channel_configs row with non-null config_encrypted
    admin
      .from('channel_configs')
      .select('account_id', { count: 'exact', head: true })
      .not('config_encrypted', 'is', null)
      .limit(1),

    // 3. users count > 1
    admin.from('users').select('id', { count: 'exact', head: true }),

    // 4. Any outbound agent message
    admin
      .from('messages')
      .select('id', { count: 'exact', head: true })
      .eq('direction', 'outbound')
      .eq('sender_type', 'agent')
      .limit(1),
  ])

  const steps = [
    { id: 'add_account', complete: (accountsRes.count ?? 0) > 0 },
    { id: 'configure_credentials', complete: (credsRes.count ?? 0) > 0 },
    { id: 'invite_teammate', complete: (usersRes.count ?? 0) > 1 },
    { id: 'first_reply', complete: (outboundRes.count ?? 0) > 0 },
  ]

  const allComplete = steps.every((s) => s.complete)

  return NextResponse.json({ steps, allComplete })
}
