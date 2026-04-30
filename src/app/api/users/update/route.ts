import { NextResponse } from 'next/server'
import { createServerSupabaseClient, createServiceRoleClient } from '@/lib/supabase-server'
import type { UserRole } from '@/types/database'

type AdminCtx = { userId: string }

const ROLES: UserRole[] = ['admin', 'reviewer', 'viewer']

async function requireAdmin(): Promise<
  | { ok: true; ctx: AdminCtx }
  | { ok: false; status: number; error: string }
> {
  const supabase = await createServerSupabaseClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { ok: false, status: 401, error: 'Unauthorized' }

  const admin = await createServiceRoleClient()
  const { data: profile } = await admin
    .from('users')
    .select('role')
    .eq('id', user.id)
    .maybeSingle()
  if (profile?.role !== 'admin') {
    return { ok: false, status: 403, error: 'Admin only' }
  }
  return { ok: true, ctx: { userId: user.id } }
}

interface UpdateBody {
  user_id?: string
  role?: UserRole
  account_id?: string | null
  is_active?: boolean
}

// POST /api/users/update
// Body: { user_id, role?, account_id?, is_active? }
// Admin-only. Updates only the provided fields. Protects against demoting
// the last remaining active admin.
export async function POST(request: Request) {
  const gate = await requireAdmin()
  if (!gate.ok) return NextResponse.json({ error: gate.error }, { status: gate.status })

  let body: UpdateBody
  try {
    body = (await request.json()) as UpdateBody
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const { user_id, role, account_id, is_active } = body
  if (!user_id || typeof user_id !== 'string') {
    return NextResponse.json({ error: 'user_id required' }, { status: 400 })
  }

  // Build patch with only provided fields
  const patch: Record<string, unknown> = {}

  if (role !== undefined) {
    if (!ROLES.includes(role)) {
      return NextResponse.json(
        { error: `role must be one of: ${ROLES.join(', ')}` },
        { status: 400 }
      )
    }
    patch.role = role
  }

  if (account_id !== undefined) {
    if (account_id !== null && typeof account_id !== 'string') {
      return NextResponse.json({ error: 'account_id must be a string or null' }, { status: 400 })
    }
    patch.account_id = account_id
  }

  if (is_active !== undefined) {
    if (typeof is_active !== 'boolean') {
      return NextResponse.json({ error: 'is_active must be a boolean' }, { status: 400 })
    }
    patch.is_active = is_active
  }

  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: 'No fields provided to update' }, { status: 400 })
  }

  const admin = await createServiceRoleClient()

  // Load the target user
  const { data: target, error: targetErr } = await admin
    .from('users')
    .select('id, email, role, account_id, is_active')
    .eq('id', user_id)
    .maybeSingle()

  if (targetErr) {
    return NextResponse.json({ error: targetErr.message }, { status: 500 })
  }
  if (!target) {
    return NextResponse.json({ error: 'User not found' }, { status: 404 })
  }

  // Validate account_id exists (when non-null)
  if (patch.account_id !== undefined && patch.account_id !== null) {
    const { data: acct, error: acctErr } = await admin
      .from('accounts')
      .select('id')
      .eq('id', patch.account_id as string)
      .maybeSingle()
    if (acctErr) {
      return NextResponse.json({ error: acctErr.message }, { status: 500 })
    }
    if (!acct) {
      return NextResponse.json({ error: 'account_id does not exist' }, { status: 400 })
    }
  }

  // Safety: prevent demoting or deactivating the last remaining active admin
  const demotingRole = patch.role !== undefined && patch.role !== 'admin' && target.role === 'admin'
  const deactivatingAdmin =
    patch.is_active !== undefined && patch.is_active === false && target.role === 'admin' && target.is_active
  if (demotingRole || deactivatingAdmin) {
    const { count, error: countErr } = await admin
      .from('users')
      .select('id', { count: 'exact', head: true })
      .eq('role', 'admin')
      .eq('is_active', true)
    if (countErr) {
      return NextResponse.json({ error: countErr.message }, { status: 500 })
    }
    // If target is currently an active admin and they're the only one,
    // blocking either action prevents the system from ending up with zero admins.
    if ((count ?? 0) <= 1 && target.is_active) {
      return NextResponse.json(
        { error: 'Cannot remove the last remaining active admin' },
        { status: 400 }
      )
    }
  }

  // Apply the update via service-role (bypasses RLS)
  const { data: updated, error: updateErr } = await admin
    .from('users')
    .update(patch)
    .eq('id', user_id)
    .select()
    .single()

  if (updateErr) {
    return NextResponse.json({ error: updateErr.message }, { status: 500 })
  }

  // Audit
  await admin.from('audit_log').insert({
    user_id: gate.ctx.userId,
    action: 'user.update',
    entity_type: 'user',
    entity_id: user_id,
    details: { changed: patch, actor_id: gate.ctx.userId },
  })

  return NextResponse.json({ success: true, user: updated })
}
