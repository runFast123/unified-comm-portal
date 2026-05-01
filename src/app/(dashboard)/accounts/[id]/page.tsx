import Link from 'next/link'
import { notFound } from 'next/navigation'
import { createServerSupabaseClient } from '@/lib/supabase-server'
import { AccountDetailClient } from './account-detail-client'

export default async function AccountDetailPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  const supabase = await createServerSupabaseClient()

  // Auth + role check
  const { data: { user: authUser } } = await supabase.auth.getUser()
  if (!authUser) notFound()

  const { data: profile } = await supabase
    .from('users')
    .select('role, account_id')
    .eq('id', authUser.id)
    .maybeSingle()

  // Fetch account via direct REST API (bypasses RLS)
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  if (!serviceKey || !supabaseUrl) notFound()

  const accountRes = await fetch(
    `${supabaseUrl}/rest/v1/accounts?id=eq.${id}&select=*&limit=1`,
    {
      headers: { 'apikey': serviceKey, 'Authorization': `Bearer ${serviceKey}` },
      cache: 'no-store',
    }
  )
  const accountArr = accountRes.ok ? await accountRes.json() : []
  const account = accountArr[0] || null

  if (!account) {
    return (
      <div className="flex flex-col items-center justify-center py-20">
        <h2 className="text-xl font-semibold text-gray-900">Account not found</h2>
        <Link href="/accounts" className="mt-4 text-teal-700 hover:underline">
          Back to accounts
        </Link>
      </div>
    )
  }

  // Non-admin users can only view their company's accounts
  if (!['admin','super_admin','company_admin'].includes(profile?.role ?? '') && profile?.account_id) {
    // Get user's own account name via REST API
    const myAccRes = await fetch(
      `${supabaseUrl}/rest/v1/accounts?id=eq.${profile.account_id}&select=name&limit=1`,
      { headers: { 'apikey': serviceKey, 'Authorization': `Bearer ${serviceKey}` }, cache: 'no-store' }
    )
    const myAccArr = myAccRes.ok ? await myAccRes.json() : []
    const baseName = (myAccArr[0]?.name || '').replace(/\s+Teams$/i, '').replace(/\s+WhatsApp$/i, '').trim()
    const targetBase = (account.name || '').replace(/\s+Teams$/i, '').replace(/\s+WhatsApp$/i, '').trim()
    if (baseName !== targetBase) notFound()
  }

  return <AccountDetailClient account={account} />
}
