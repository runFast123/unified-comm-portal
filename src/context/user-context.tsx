'use client'
import { createContext, useContext, useState, useEffect } from 'react'
import { createClient } from '@/lib/supabase-client'

interface UserContextType {
  email: string
  full_name: string | null
  role: string
  account_id: string | null
  isAdmin: boolean
  /** All account IDs for the same company (email + teams + whatsapp siblings) */
  companyAccountIds: string[]
}

const UserContext = createContext<UserContextType>({
  email: '',
  full_name: null,
  role: 'viewer',
  account_id: null,
  isAdmin: false,
  companyAccountIds: [],
})

export function UserProvider({ user, children }: { user: Omit<UserContextType, 'isAdmin' | 'companyAccountIds'>; children: React.ReactNode }) {
  const [companyAccountIds, setCompanyAccountIds] = useState<string[]>(user.account_id ? [user.account_id] : [])

  // Fetch sibling accounts (same company, different channels)
  useEffect(() => {
    if (!user.account_id || user.role === 'admin') return
    async function fetchSiblings() {
      const supabase = createClient()
      // Get the account name first
      const { data: myAccount } = await supabase
        .from('accounts')
        .select('name')
        .eq('id', user.account_id!)
        .maybeSingle()

      if (!myAccount?.name) return

      // Find sibling accounts with the same base name
      const baseName = myAccount.name.replace(/\s+Teams$/i, '').replace(/\s+WhatsApp$/i, '').trim()
      const { data: siblings } = await supabase
        .from('accounts')
        .select('id, name')
        .eq('is_active', true)

      if (siblings) {
        const siblingIds = siblings
          .filter(a => a.name.replace(/\s+Teams$/i, '').replace(/\s+WhatsApp$/i, '').trim() === baseName)
          .map(a => a.id)
        if (siblingIds.length > 0) setCompanyAccountIds(siblingIds)
      }
    }
    fetchSiblings()
  }, [user.account_id, user.role])

  return (
    <UserContext.Provider value={{ ...user, isAdmin: user.role === 'admin', companyAccountIds }}>
      {children}
    </UserContext.Provider>
  )
}

export function useUser() {
  return useContext(UserContext)
}
