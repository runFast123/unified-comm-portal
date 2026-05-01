// Per-account Out-of-Office (OOO) configuration API.
//
//   GET  /api/accounts/:id/ooo   read OOO config (any company member of
//                                the owning company; super_admin global)
//   PUT  /api/accounts/:id/ooo   update OOO config (company_admin or
//                                super_admin only)
//
// Auth gating mirrors the templates API: super_admin sees / writes
// anything; company_admin is scoped to accounts in their own company;
// other roles are read-only within their company. RLS at the DB layer
// is the second line of defence.

import { NextResponse } from 'next/server'
import {
  createServerSupabaseClient,
  createServiceRoleClient,
} from '@/lib/supabase-server'
import { getCurrentUser, isCompanyAdmin, isSuperAdmin } from '@/lib/auth'

interface UpdateBody {
  ooo_enabled?: boolean
  ooo_starts_at?: string | null
  ooo_ends_at?: string | null
  ooo_subject?: string | null
  ooo_body?: string | null
}

interface SessionGate {
  ok: true
  userId: string
  companyId: string | null
  role: string
}

interface SessionFail {
  ok: false
  status: number
  error: string
}

async function getSession(): Promise<SessionGate | SessionFail> {
  const supabase = await createServerSupabaseClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return { ok: false, status: 401, error: 'Unauthorized' }

  const profile = await getCurrentUser(user.id)
  if (!profile) {
    return { ok: false, status: 403, error: 'No profile found for user' }
  }
  return {
    ok: true,
    userId: user.id,
    companyId: profile.company_id ?? null,
    role: profile.role || '',
  }
}

/** Returns the account row iff the caller can access it; 403/404 otherwise. */
async function loadAccessibleAccount(
  id: string,
  gate: SessionGate
): Promise<
  | { ok: true; account: Record<string, unknown> }
  | { ok: false; status: number; error: string }
> {
  const admin = await createServiceRoleClient()
  const { data, error } = await admin
    .from('accounts')
    .select(
      'id, name, company_id, ooo_enabled, ooo_starts_at, ooo_ends_at, ooo_subject, ooo_body'
    )
    .eq('id', id)
    .maybeSingle()

  if (error) return { ok: false, status: 500, error: error.message }
  if (!data) return { ok: false, status: 404, error: 'Account not found' }

  if (!isSuperAdmin(gate.role)) {
    if (!gate.companyId) {
      return { ok: false, status: 403, error: 'Forbidden' }
    }
    if (data.company_id && data.company_id !== gate.companyId) {
      return { ok: false, status: 403, error: 'Forbidden' }
    }
  }
  return { ok: true, account: data }
}

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const gate = await getSession()
  if (!gate.ok) {
    return NextResponse.json({ error: gate.error }, { status: gate.status })
  }
  const { id } = await context.params
  const result = await loadAccessibleAccount(id, gate)
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status })
  }
  const a = result.account
  return NextResponse.json({
    ooo: {
      account_id: a.id,
      ooo_enabled: !!a.ooo_enabled,
      ooo_starts_at: a.ooo_starts_at ?? null,
      ooo_ends_at: a.ooo_ends_at ?? null,
      ooo_subject: a.ooo_subject ?? null,
      ooo_body: a.ooo_body ?? null,
    },
  })
}

export async function PUT(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const gate = await getSession()
  if (!gate.ok) {
    return NextResponse.json({ error: gate.error }, { status: gate.status })
  }
  if (!isSuperAdmin(gate.role) && !isCompanyAdmin(gate.role)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }
  const { id } = await context.params
  const existing = await loadAccessibleAccount(id, gate)
  if (!existing.ok) {
    return NextResponse.json(
      { error: existing.error },
      { status: existing.status }
    )
  }

  let body: UpdateBody
  try {
    body = (await request.json()) as UpdateBody
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  // Build the patch — only set fields the caller actually included so a
  // PUT-with-{} is a safe no-op.
  const patch: Record<string, unknown> = {}
  if (body.ooo_enabled !== undefined) patch.ooo_enabled = !!body.ooo_enabled

  if (body.ooo_starts_at !== undefined) {
    if (body.ooo_starts_at === null || body.ooo_starts_at === '') {
      patch.ooo_starts_at = null
    } else {
      const t = Date.parse(body.ooo_starts_at)
      if (!Number.isFinite(t)) {
        return NextResponse.json(
          { error: 'ooo_starts_at must be an ISO datetime or null' },
          { status: 400 }
        )
      }
      patch.ooo_starts_at = new Date(t).toISOString()
    }
  }

  if (body.ooo_ends_at !== undefined) {
    if (body.ooo_ends_at === null || body.ooo_ends_at === '') {
      patch.ooo_ends_at = null
    } else {
      const t = Date.parse(body.ooo_ends_at)
      if (!Number.isFinite(t)) {
        return NextResponse.json(
          { error: 'ooo_ends_at must be an ISO datetime or null' },
          { status: 400 }
        )
      }
      patch.ooo_ends_at = new Date(t).toISOString()
    }
  }

  if (body.ooo_subject !== undefined) {
    patch.ooo_subject =
      body.ooo_subject === null
        ? null
        : String(body.ooo_subject).trim().slice(0, 500) || null
  }

  if (body.ooo_body !== undefined) {
    patch.ooo_body =
      body.ooo_body === null
        ? null
        : String(body.ooo_body).slice(0, 10000) || null
  }

  // Cross-field sanity check: if both bounds are set, end must be > start.
  // We only enforce this when both have meaningful values in the *resulting*
  // row (caller's patch + existing row).
  const merged = { ...existing.account, ...patch }
  if (
    merged.ooo_starts_at &&
    merged.ooo_ends_at &&
    Date.parse(merged.ooo_ends_at as string) <=
      Date.parse(merged.ooo_starts_at as string)
  ) {
    return NextResponse.json(
      { error: 'ooo_ends_at must be after ooo_starts_at' },
      { status: 400 }
    )
  }

  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: 'no fields to update' }, { status: 400 })
  }

  const admin = await createServiceRoleClient()
  const { data, error } = await admin
    .from('accounts')
    .update(patch)
    .eq('id', id)
    .select(
      'id, name, ooo_enabled, ooo_starts_at, ooo_ends_at, ooo_subject, ooo_body'
    )
    .single()

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({
    ooo: {
      account_id: data.id,
      ooo_enabled: !!data.ooo_enabled,
      ooo_starts_at: data.ooo_starts_at ?? null,
      ooo_ends_at: data.ooo_ends_at ?? null,
      ooo_subject: data.ooo_subject ?? null,
      ooo_body: data.ooo_body ?? null,
    },
  })
}
