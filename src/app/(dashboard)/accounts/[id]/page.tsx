import Link from 'next/link'
import { notFound } from 'next/navigation'
import { createServerSupabaseClient, createServiceRoleClient } from '@/lib/supabase-server'
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

  // Non-admin users can only view their company's accounts
  if (profile?.role !== 'admin' && profile?.account_id) {
    const adminSupabase = await createServiceRoleClient()
    const { data: myAccount } = await adminSupabase.from('accounts').select('name').eq('id', profile.account_id).maybeSingle()
    const baseName = (myAccount?.name || '').replace(/\s+Teams$/i, '').replace(/\s+WhatsApp$/i, '').trim()
    const { data: targetAccount } = await adminSupabase.from('accounts').select('name').eq('id', id).maybeSingle()
    const targetBase = (targetAccount?.name || '').replace(/\s+Teams$/i, '').replace(/\s+WhatsApp$/i, '').trim()
    if (baseName !== targetBase) notFound()
  }

  const { data: account } = await supabase
    .from('accounts')
    .select('*')
    .eq('id', id)
    .maybeSingle()

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

  return <AccountDetailClient account={account} />
}
