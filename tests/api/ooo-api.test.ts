// Tests for /api/accounts/[id]/ooo
//
// Covers:
//   * 401 unauthenticated on GET / PUT
//   * 403 when caller has no profile / no company / wrong role
//   * GET / PUT scoped to the caller's company (cross-company → 403)
//   * PUT validates dates (bad ISO → 400; end <= start → 400)
//   * PUT happy-path persists the patch and echoes the canonical row
//   * super_admin can read / write across companies

import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('next/headers', () => ({
  headers: async () => ({ get: () => null }),
  cookies: async () => ({ getAll: () => [], set: () => {} }),
}))

interface Profile {
  id: string
  email: string
  full_name: string | null
  role: string
  account_id: string | null
  company_id: string | null
}

interface AccountRow {
  id: string
  name: string
  company_id: string | null
  ooo_enabled: boolean
  ooo_starts_at: string | null
  ooo_ends_at: string | null
  ooo_subject: string | null
  ooo_body: string | null
}

const fixture = {
  user: { id: 'user-1' } as { id: string } | null,
  profile: {
    id: 'user-1',
    email: 'admin@a.example',
    full_name: 'Admin A',
    role: 'company_admin',
    account_id: null,
    company_id: 'comp-a',
  } as Profile | null,
  accounts: [
    {
      id: 'acct-a',
      name: 'A account',
      company_id: 'comp-a',
      ooo_enabled: false,
      ooo_starts_at: null,
      ooo_ends_at: null,
      ooo_subject: 'Out of office',
      ooo_body: null,
    },
    {
      id: 'acct-b',
      name: 'B account',
      company_id: 'comp-b',
      ooo_enabled: false,
      ooo_starts_at: null,
      ooo_ends_at: null,
      ooo_subject: 'Out of office',
      ooo_body: null,
    },
  ] as AccountRow[],
  updates: [] as Array<{ id: string; payload: Record<string, unknown> }>,
}

function makeServerClient() {
  return {
    auth: {
      getUser: async () => ({ data: { user: fixture.user }, error: null }),
    },
  }
}

function makeServiceClient() {
  return {
    from: (table: string) => {
      const filters: Array<{ col: string; value: unknown }> = []
      let mode: 'select' | 'update' = 'select'
      let updatePayload: Record<string, unknown> | null = null
      let returnArray = true

      const exec = async () => {
        if (table === 'users') {
          return { data: fixture.profile, error: null }
        }
        if (table === 'accounts') {
          if (mode === 'select') {
            const idEq = filters.find((f) => f.col === 'id')
            const row = fixture.accounts.find((r) => r.id === idEq?.value) ?? null
            return returnArray ? { data: row ? [row] : [], error: null } : { data: row, error: null }
          }
          if (mode === 'update') {
            const idEq = filters.find((f) => f.col === 'id')
            if (!idEq) return { data: null, error: null }
            fixture.updates.push({ id: String(idEq.value), payload: updatePayload || {} })
            const i = fixture.accounts.findIndex((r) => r.id === idEq.value)
            if (i < 0) return { data: null, error: null }
            const merged = { ...fixture.accounts[i], ...(updatePayload || {}) } as AccountRow
            fixture.accounts[i] = merged
            return { data: merged, error: null }
          }
        }
        return { data: null, error: null }
      }

      const chain: Record<string, unknown> = {
        select: () => {
          if (mode !== 'update') mode = 'select'
          return chain
        },
        update: (payload: Record<string, unknown>) => {
          mode = 'update'
          updatePayload = payload
          return chain
        },
        eq: (col: string, value: unknown) => {
          filters.push({ col, value })
          return chain
        },
        maybeSingle: async () => {
          returnArray = false
          return exec()
        },
        single: async () => {
          returnArray = false
          return exec()
        },
      }
      return chain
    },
  }
}

vi.mock('@/lib/supabase-server', () => ({
  createServerSupabaseClient: vi.fn(async () => makeServerClient()),
  createServiceRoleClient: vi.fn(async () => makeServiceClient()),
}))

import { GET as oooGET, PUT as oooPUT } from '@/app/api/accounts/[id]/ooo/route'

beforeEach(() => {
  fixture.user = { id: 'user-1' }
  fixture.profile = {
    id: 'user-1',
    email: 'admin@a.example',
    full_name: 'Admin A',
    role: 'company_admin',
    account_id: null,
    company_id: 'comp-a',
  }
  fixture.accounts = [
    {
      id: 'acct-a',
      name: 'A account',
      company_id: 'comp-a',
      ooo_enabled: false,
      ooo_starts_at: null,
      ooo_ends_at: null,
      ooo_subject: 'Out of office',
      ooo_body: null,
    },
    {
      id: 'acct-b',
      name: 'B account',
      company_id: 'comp-b',
      ooo_enabled: false,
      ooo_starts_at: null,
      ooo_ends_at: null,
      ooo_subject: 'Out of office',
      ooo_body: null,
    },
  ]
  fixture.updates = []
})

function jsonReq(url: string, method: string, body?: unknown): Request {
  return new Request(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
}

describe('GET /api/accounts/[id]/ooo', () => {
  it('401 when unauthenticated', async () => {
    fixture.user = null
    const res = await oooGET(jsonReq('http://l/x', 'GET'), {
      params: Promise.resolve({ id: 'acct-a' }),
    })
    expect(res.status).toBe(401)
  })

  it('403 when caller has no profile', async () => {
    fixture.profile = null
    const res = await oooGET(jsonReq('http://l/x', 'GET'), {
      params: Promise.resolve({ id: 'acct-a' }),
    })
    expect(res.status).toBe(403)
  })

  it('returns the OOO config for own-company account', async () => {
    const res = await oooGET(jsonReq('http://l/x', 'GET'), {
      params: Promise.resolve({ id: 'acct-a' }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { ooo: { account_id: string; ooo_enabled: boolean } }
    expect(body.ooo.account_id).toBe('acct-a')
    expect(body.ooo.ooo_enabled).toBe(false)
  })

  it('403 when reading a cross-company account', async () => {
    const res = await oooGET(jsonReq('http://l/x', 'GET'), {
      params: Promise.resolve({ id: 'acct-b' }),
    })
    expect(res.status).toBe(403)
  })

  it('404 for unknown account', async () => {
    const res = await oooGET(jsonReq('http://l/x', 'GET'), {
      params: Promise.resolve({ id: 'no-such' }),
    })
    expect(res.status).toBe(404)
  })

  it('super_admin sees cross-company accounts', async () => {
    fixture.profile!.role = 'super_admin'
    fixture.profile!.company_id = null
    const res = await oooGET(jsonReq('http://l/x', 'GET'), {
      params: Promise.resolve({ id: 'acct-b' }),
    })
    expect(res.status).toBe(200)
  })
})

describe('PUT /api/accounts/[id]/ooo', () => {
  it('401 when unauthenticated', async () => {
    fixture.user = null
    const res = await oooPUT(jsonReq('http://l/x', 'PUT', { ooo_enabled: true }), {
      params: Promise.resolve({ id: 'acct-a' }),
    })
    expect(res.status).toBe(401)
  })

  it('403 when caller is a plain member', async () => {
    fixture.profile!.role = 'company_member'
    const res = await oooPUT(jsonReq('http://l/x', 'PUT', { ooo_enabled: true }), {
      params: Promise.resolve({ id: 'acct-a' }),
    })
    expect(res.status).toBe(403)
  })

  it('403 when company_admin patches a cross-company account', async () => {
    const res = await oooPUT(jsonReq('http://l/x', 'PUT', { ooo_enabled: true }), {
      params: Promise.resolve({ id: 'acct-b' }),
    })
    expect(res.status).toBe(403)
  })

  it('400 when ooo_starts_at is not parseable', async () => {
    const res = await oooPUT(
      jsonReq('http://l/x', 'PUT', { ooo_starts_at: 'not-a-date' }),
      { params: Promise.resolve({ id: 'acct-a' }) }
    )
    expect(res.status).toBe(400)
  })

  it('400 when end <= start', async () => {
    const res = await oooPUT(
      jsonReq('http://l/x', 'PUT', {
        ooo_starts_at: '2026-05-10T00:00:00Z',
        ooo_ends_at: '2026-05-01T00:00:00Z',
      }),
      { params: Promise.resolve({ id: 'acct-a' }) }
    )
    expect(res.status).toBe(400)
  })

  it('200 happy-path: persists toggle + dates + subject/body', async () => {
    const res = await oooPUT(
      jsonReq('http://l/x', 'PUT', {
        ooo_enabled: true,
        ooo_starts_at: '2026-05-01T00:00:00Z',
        ooo_ends_at: '2026-05-10T00:00:00Z',
        ooo_subject: 'On leave',
        ooo_body: 'Back {{ooo.return_date}}',
      }),
      { params: Promise.resolve({ id: 'acct-a' }) }
    )
    expect(res.status).toBe(200)
    expect(fixture.updates.length).toBe(1)
    const u = fixture.updates[0]
    expect(u.id).toBe('acct-a')
    expect(u.payload.ooo_enabled).toBe(true)
    expect(u.payload.ooo_subject).toBe('On leave')
    expect(u.payload.ooo_body).toBe('Back {{ooo.return_date}}')
  })

  it('400 when no fields are provided', async () => {
    const res = await oooPUT(jsonReq('http://l/x', 'PUT', {}), {
      params: Promise.resolve({ id: 'acct-a' }),
    })
    expect(res.status).toBe(400)
  })

  it('400 on invalid JSON', async () => {
    const req = new Request('http://l/x', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: 'not json',
    })
    const res = await oooPUT(req, { params: Promise.resolve({ id: 'acct-a' }) })
    expect(res.status).toBe(400)
  })

  it('super_admin can patch any company', async () => {
    fixture.profile!.role = 'super_admin'
    fixture.profile!.company_id = null
    const res = await oooPUT(
      jsonReq('http://l/x', 'PUT', { ooo_enabled: true }),
      { params: Promise.resolve({ id: 'acct-b' }) }
    )
    expect(res.status).toBe(200)
  })

  it('clears dates when explicit null is passed', async () => {
    fixture.accounts[0] = {
      ...fixture.accounts[0],
      ooo_starts_at: '2026-05-01T00:00:00.000Z',
      ooo_ends_at: '2026-05-10T00:00:00.000Z',
    }
    const res = await oooPUT(
      jsonReq('http://l/x', 'PUT', { ooo_starts_at: null, ooo_ends_at: null }),
      { params: Promise.resolve({ id: 'acct-a' }) }
    )
    expect(res.status).toBe(200)
    const u = fixture.updates[0]
    expect(u.payload.ooo_starts_at).toBeNull()
    expect(u.payload.ooo_ends_at).toBeNull()
  })
})
