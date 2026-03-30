import Link from 'next/link'
import { createServerSupabaseClient } from '@/lib/supabase-server'
import { AccountDetailClient } from './account-detail-client'

export default async function AccountDetailPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  const supabase = await createServerSupabaseClient()
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
