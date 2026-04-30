/**
 * Company-default email signature management. Admin-only.
 *
 *   GET  /api/admin/companies/:id/signature -> read default + name
 *   POST /api/admin/companies/:id/signature -> write default
 *
 * Coordinates with the parallel multi-tenancy migration: this route only
 * reads/writes the `default_email_signature` column, never anything else
 * on `companies`.
 */

import { NextResponse } from 'next/server'
import { createServerSupabaseClient, createServiceRoleClient } from '@/lib/supabase-server'

interface UpdateBody {
  default_email_signature?: string | null
}

// Allowed roles for editing the company default signature. We accept the
// modern role names (`super_admin`, `company_admin`) introduced by the
// multi-tenancy migration AND the legacy `admin` role so the route works
// on either side of that rollout.
const SIG_EDIT_ROLES = new Set(['super_admin', 'admin', 'company_admin'])

async function requireAdmin() {
  const supabase = await createServerSupabaseClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { ok: false as const, status: 401, error: 'Unauthorized' }

  const admin = await createServiceRoleClient()
  const { data: profile } = await admin
    .from('users')
    .select('role')
    .eq('id', user.id)
    .maybeSingle()
  if (!profile?.role || !SIG_EDIT_ROLES.has(profile.role as string)) {
    return { ok: false as const, status: 403, error: 'Admin only' }
  }
  return { ok: true as const, admin, userId: user.id }
}

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const gate = await requireAdmin()
  if (!gate.ok) return NextResponse.json({ error: gate.error }, { status: gate.status })
  const { id } = await context.params

  const { data, error } = await gate.admin
    .from('companies')
    .select('id, name, default_email_signature')
    .eq('id', id)
    .maybeSingle()
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  if (!data) return NextResponse.json({ error: 'Company not found' }, { status: 404 })
  return NextResponse.json({ company: data })
}

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const gate = await requireAdmin()
  if (!gate.ok) return NextResponse.json({ error: gate.error }, { status: gate.status })
  const { id } = await context.params

  let body: UpdateBody
  try {
    body = (await request.json()) as UpdateBody
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  if (body.default_email_signature !== undefined) {
    if (
      body.default_email_signature !== null &&
      typeof body.default_email_signature !== 'string'
    ) {
      return NextResponse.json(
        { error: 'default_email_signature must be a string or null' },
        { status: 400 },
      )
    }
    if (
      typeof body.default_email_signature === 'string' &&
      body.default_email_signature.length > 8192
    ) {
      return NextResponse.json(
        { error: 'default_email_signature exceeds 8KB' },
        { status: 400 },
      )
    }
  } else {
    return NextResponse.json({ error: 'No fields to update' }, { status: 400 })
  }

  const { error: updateErr } = await gate.admin
    .from('companies')
    .update({ default_email_signature: body.default_email_signature })
    .eq('id', id)
  if (updateErr) return NextResponse.json({ error: updateErr.message }, { status: 500 })

  try {
    await gate.admin.from('audit_log').insert({
      user_id: gate.userId,
      action: 'company.signature.update',
      entity_type: 'company',
      entity_id: id,
      details: { has_signature: body.default_email_signature !== null && body.default_email_signature !== '' },
    })
  } catch { /* non-fatal */ }

  return NextResponse.json({ success: true })
}
