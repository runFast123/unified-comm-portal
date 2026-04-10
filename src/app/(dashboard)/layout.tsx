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
  // Uses direct REST API with service role key to bypass ALL RLS policies
  let companyAccountIds: string[] = user.account_id ? [user.account_id] : []
  if (user.role !== 'admin' && user.account_id) {
    try {
      const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
      const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
      if (serviceKey && supabaseUrl) {
        const res = await fetch(
          `${supabaseUrl}/rest/v1/accounts?select=id,name&is_active=eq.true`,
          {
            headers: { 'apikey': serviceKey, 'Authorization': `Bearer ${serviceKey}` },
            cache: 'no-store',
          }
        )
        if (res.ok) {
          const allAccounts: { id: string; name: string }[] = await res.json()
          const myAccount = allAccounts.find(a => a.id === user.account_id)
          if (myAccount) {
            const baseName = myAccount.name.replace(/\s+Teams$/i, '').replace(/\s+WhatsApp$/i, '').trim()
            companyAccountIds = allAccounts
              .filter(a => a.name.replace(/\s+Teams$/i, '').replace(/\s+WhatsApp$/i, '').trim() === baseName)
              .map(a => a.id)
          }
        }
      }
    } catch { /* fallback to single account_id */ }
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
