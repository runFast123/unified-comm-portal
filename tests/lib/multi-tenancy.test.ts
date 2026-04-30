// Multi-tenancy unit tests.
//
// These tests run against the in-memory mock Supabase client (see
// tests/helpers/mock-supabase.ts). They verify the TS-level behavior of
// the multi-tenancy helpers (`isSuperAdmin`, `isCompanyAdmin`,
// `getCurrentUser`, `getUserCompany`, `getAllowedAccountIds`) and the
// refactored `verifyAccountAccess`.
//
// DB-level guarantees (RLS, triggers, the backfill) are validated end-to-end
// by `tests/integration/conversation-access.test.ts` against the live
// schema; here we only need to cover the pure TS branches.

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createMockSupabase, type MockSupabase } from '../helpers/mock-supabase'

vi.mock('@/lib/supabase-server', () => ({
  createServerSupabaseClient: vi.fn(),
  createServiceRoleClient: vi.fn(),
}))
vi.mock('@/lib/rate-limiter', () => ({
  checkRateLimit: vi.fn(),
}))

import { createServiceRoleClient } from '@/lib/supabase-server'
import {
  isSuperAdmin,
  isCompanyAdmin,
  getCurrentUser,
  getUserCompany,
  getAllowedAccountIds,
} from '@/lib/auth'
import { verifyAccountAccess } from '@/lib/api-helpers'

const SUPER = '00000000-0000-0000-0000-000000000001'
const COMP_A = '00000000-0000-0000-0000-0000000000aa'
const COMP_B = '00000000-0000-0000-0000-0000000000bb'
const ACCT_A1 = '00000000-0000-0000-0000-00000000a001'
const ACCT_A2 = '00000000-0000-0000-0000-00000000a002'
const ACCT_B1 = '00000000-0000-0000-0000-00000000b001'
const USER_SUPER = '00000000-0000-0000-0000-0000000000ff'
const USER_A = '00000000-0000-0000-0000-0000000000a1'
const USER_B = '00000000-0000-0000-0000-0000000000b1'
const USER_LEGACY = '00000000-0000-0000-0000-0000000000c1'

const usersById: Record<string, Record<string, unknown>> = {
  [USER_SUPER]: {
    id: USER_SUPER,
    email: 'super@x',
    full_name: 'Super',
    role: 'super_admin',
    account_id: null,
    company_id: null,
  },
  [USER_A]: {
    id: USER_A,
    email: 'a@x',
    full_name: 'A',
    role: 'company_admin',
    account_id: ACCT_A1,
    company_id: COMP_A,
  },
  [USER_B]: {
    id: USER_B,
    email: 'b@x',
    full_name: 'B',
    role: 'company_member',
    account_id: ACCT_B1,
    company_id: COMP_B,
  },
  [USER_LEGACY]: {
    id: USER_LEGACY,
    email: 'legacy@x',
    full_name: 'Legacy',
    role: 'admin',
    account_id: ACCT_A1,
    company_id: null,
  },
}

const accountsById: Record<string, Record<string, unknown>> = {
  [ACCT_A1]: { id: ACCT_A1, name: 'Acme Teams', company_id: COMP_A },
  [ACCT_A2]: { id: ACCT_A2, name: 'Acme WhatsApp', company_id: COMP_A },
  [ACCT_B1]: { id: ACCT_B1, name: 'Other Co', company_id: COMP_B },
}

const companiesById: Record<string, Record<string, unknown>> = {
  [COMP_A]: {
    id: COMP_A,
    name: 'Acme',
    slug: 'acme',
    logo_url: null,
    accent_color: '#0e7490',
  },
  [COMP_B]: {
    id: COMP_B,
    name: 'Other Co',
    slug: 'other',
    logo_url: null,
    accent_color: null,
  },
}

function buildMock(): MockSupabase {
  return createMockSupabase({
    handlers: {
      users: {
        onSelect: (filters) => {
          const eq = filters?.find((f) => f.kind === 'eq' && f.col === 'id')
          const id = eq?.value as string
          return { data: usersById[id] ?? null, error: null }
        },
      },
      accounts: {
        onSelect: (filters) => {
          // .eq('id', X).maybeSingle() OR .eq('company_id', X) [no terminal]
          const idEq = filters?.find((f) => f.kind === 'eq' && f.col === 'id')
          const compEq = filters?.find((f) => f.kind === 'eq' && f.col === 'company_id')
          if (idEq) {
            return { data: accountsById[idEq.value as string] ?? null, error: null }
          }
          if (compEq) {
            const rows = Object.values(accountsById).filter(
              (a) => a.company_id === compEq.value
            )
            // The mock's terminal returns only the first row for selects
            // unless an array is in `data`. The auth helper iterates `data`
            // so we return the array.
            return { data: rows, error: null } as unknown as { data: unknown; error: unknown }
          }
          return { data: null, error: null }
        },
      },
      companies: {
        onSelect: (filters) => {
          const eq = filters?.find((f) => f.kind === 'eq' && f.col === 'id')
          const id = eq?.value as string
          return { data: companiesById[id] ?? null, error: null }
        },
      },
    },
  })
}

describe('isSuperAdmin / isCompanyAdmin', () => {
  it('treats super_admin as super and company admin', () => {
    expect(isSuperAdmin('super_admin')).toBe(true)
    expect(isCompanyAdmin('super_admin')).toBe(true)
  })
  it('legacy admin is company admin but not super', () => {
    expect(isSuperAdmin('admin')).toBe(false)
    expect(isCompanyAdmin('admin')).toBe(true)
  })
  it('company_admin is company admin but not super', () => {
    expect(isSuperAdmin('company_admin')).toBe(false)
    expect(isCompanyAdmin('company_admin')).toBe(true)
  })
  it('member / null / unknown is neither', () => {
    expect(isSuperAdmin('company_member')).toBe(false)
    expect(isCompanyAdmin('company_member')).toBe(false)
    expect(isSuperAdmin(null)).toBe(false)
    expect(isCompanyAdmin(undefined)).toBe(false)
    expect(isSuperAdmin('hacker')).toBe(false)
  })
})

describe('getCurrentUser / getUserCompany', () => {
  beforeEach(() => {
    vi.mocked(createServiceRoleClient).mockResolvedValue(buildMock().client as never)
  })

  it('returns the user row when present', async () => {
    const user = await getCurrentUser(USER_A)
    expect(user?.id).toBe(USER_A)
    expect(user?.role).toBe('company_admin')
    expect(user?.company_id).toBe(COMP_A)
  })

  it('returns null when user not found', async () => {
    const user = await getCurrentUser('does-not-exist')
    expect(user).toBeNull()
  })

  it('returns null when userId is empty', async () => {
    expect(await getCurrentUser('')).toBeNull()
  })

  it('getUserCompany resolves a company for a company-attached user', async () => {
    const company = await getUserCompany(USER_A)
    expect(company?.id).toBe(COMP_A)
    expect(company?.slug).toBe('acme')
  })

  it('getUserCompany returns null for a user with no company', async () => {
    const company = await getUserCompany(USER_SUPER)
    expect(company).toBeNull()
  })
})

describe('getAllowedAccountIds', () => {
  beforeEach(() => {
    vi.mocked(createServiceRoleClient).mockResolvedValue(buildMock().client as never)
  })

  it('returns null (all-access sentinel) for super_admin', async () => {
    const allowed = await getAllowedAccountIds(USER_SUPER)
    expect(allowed).toBeNull()
  })

  it('returns the company siblings for a company user', async () => {
    const allowed = await getAllowedAccountIds(USER_A)
    expect(allowed).not.toBeNull()
    // includes Acme Teams + Acme WhatsApp
    expect(allowed!.has(ACCT_A1)).toBe(true)
    expect(allowed!.has(ACCT_A2)).toBe(true)
    expect(allowed!.has(ACCT_B1)).toBe(false)
  })

  it('returns just the user account for legacy admins with no company', async () => {
    const allowed = await getAllowedAccountIds(USER_LEGACY)
    expect(allowed).not.toBeNull()
    expect(allowed!.has(ACCT_A1)).toBe(true)
    expect(allowed!.has(ACCT_B1)).toBe(false)
  })

  it('returns empty set for unknown users', async () => {
    const allowed = await getAllowedAccountIds('nope')
    expect(allowed).not.toBeNull()
    expect(allowed!.size).toBe(0)
  })
})

describe('verifyAccountAccess', () => {
  beforeEach(() => {
    vi.mocked(createServiceRoleClient).mockResolvedValue(buildMock().client as never)
  })

  it('super_admin can access any account', async () => {
    expect(await verifyAccountAccess(USER_SUPER, ACCT_B1)).toBe(true)
    expect(await verifyAccountAccess(USER_SUPER, ACCT_A1)).toBe(true)
  })

  it('company user can access sibling account in same company', async () => {
    expect(await verifyAccountAccess(USER_A, ACCT_A2)).toBe(true)
  })

  it('company user CANNOT access account in another company', async () => {
    expect(await verifyAccountAccess(USER_A, ACCT_B1)).toBe(false)
  })

  it('user can always access their own account (legacy with no company)', async () => {
    expect(await verifyAccountAccess(USER_LEGACY, ACCT_A1)).toBe(true)
  })

  it('legacy user with no company cannot access other accounts', async () => {
    expect(await verifyAccountAccess(USER_LEGACY, ACCT_A2)).toBe(false)
    expect(await verifyAccountAccess(USER_LEGACY, ACCT_B1)).toBe(false)
  })

  it('unknown user is denied', async () => {
    expect(await verifyAccountAccess('nope', ACCT_A1)).toBe(false)
  })
})
