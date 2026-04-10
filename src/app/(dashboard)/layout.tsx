import { redirect } from 'next/navigation'
import { createServerSupabaseClient } from '@/lib/supabase-server'
import { DashboardShell } from '@/components/dashboard/dashboard-shell'
import type { User } from '@/types/database'

// Force dynamic rendering — layout must run on every request to compute
// user-specific companyAccountIds (different per user session)
export const dynamic = 'force-dynamic'

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const supabase = await createServerSupabaseClient()

  // Check authentication
  const {
    data: { user: authUser },
  } = await supabase.auth.getUser()

  if (!authUser) {
    redirect('/login')
  }

  // Fetch user profile
  const { data: profile } = await supabase
    .from('users')
    .select('*')
    .eq('id', authUser.id)
    .maybeSingle()

  const user: Pick<User, 'email' | 'full_name' | 'role' | 'account_id'> = {
    email: profile?.email ?? authUser.email ?? '',
    full_name: profile?.full_name ?? null,
    role: profile?.role ?? 'viewer',
    account_id: profile?.account_id ?? null,
  }

  // Fetch sibling account IDs (same company, different channels) for non-admin users
  let companyAccountIds: string[] = user.account_id ? [user.account_id] : []
  if (user.role !== 'admin' && user.account_id) {
    const { data: myAccount, error: myAccErr } = await supabase
      .from('accounts')
      .select('name')
      .eq('id', user.account_id)
      .maybeSingle()

    if (myAccErr) {
      console.error('[LAYOUT] Failed to fetch own account:', myAccErr.message)
    }

    if (myAccount?.name) {
      const baseName = myAccount.name.replace(/\s+Teams$/i, '').replace(/\s+WhatsApp$/i, '').trim()
      const { data: allAccounts, error: allAccErr } = await supabase
        .from('accounts')
        .select('id, name')
        .eq('is_active', true)

      if (allAccErr) {
        console.error('[LAYOUT] Failed to fetch all accounts:', allAccErr.message)
      }

      console.log('[LAYOUT] Sibling lookup:', {
        email: user.email,
        myName: myAccount.name,
        baseName,
        allAccountsCount: allAccounts?.length ?? 0,
        allAccountsError: allAccErr?.message ?? null,
      })

      if (allAccounts) {
        companyAccountIds = allAccounts
          .filter(a => a.name.replace(/\s+Teams$/i, '').replace(/\s+WhatsApp$/i, '').trim() === baseName)
          .map(a => a.id)
      }

      console.log('[LAYOUT] Final companyAccountIds:', companyAccountIds)
    } else {
      console.error('[LAYOUT] Own account not found for id:', user.account_id)
    }
  }

  // Fetch pending reply count (scoped for non-admins)
  let pendingQuery = supabase
    .from('ai_replies')
    .select('*', { count: 'exact', head: true })
    .eq('status', 'pending_approval')
  if (user.role !== 'admin' && companyAccountIds.length > 0) {
    pendingQuery = pendingQuery.in('account_id', companyAccountIds)
  }
  const { count: pendingCount } = await pendingQuery

  return (
    <DashboardShell user={user} pendingCount={pendingCount ?? 0} companyAccountIds={companyAccountIds}>
      {children}
    </DashboardShell>
  )
}
