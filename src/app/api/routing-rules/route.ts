// CRUD for `public.routing_rules`. Admin-only.
//
// GET   /api/routing-rules          → list all rules (admin sees everything)
// POST  /api/routing-rules          → create rule
// PATCH /api/routing-rules?id=...   → update rule
// DELETE /api/routing-rules?id=...  → delete rule

import { NextResponse } from 'next/server'
import {
  createServerSupabaseClient,
  createServiceRoleClient,
} from '@/lib/supabase-server'

async function requireAdmin(): Promise<
  | { ok: true; userId: string }
  | { ok: false; status: number; error: string }
> {
  const supabase = await createServerSupabaseClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
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
  return { ok: true, userId: user.id }
}

interface RuleBody {
  name?: string
  is_active?: boolean
  priority?: number
  conditions?: Array<{ field: string; op: string; value: unknown }>
  match_mode?: 'all' | 'any'
  set_priority?: string | null
  set_status?: string | null
  add_tags?: string[] | null
  assign_to_team?: string | null
  assign_to_user?: string | null
  use_round_robin?: boolean
  account_id?: string | null
}

function sanitizeBody(body: RuleBody): Record<string, unknown> {
  const patch: Record<string, unknown> = {}
  if (body.name !== undefined) patch.name = String(body.name).slice(0, 200)
  if (body.is_active !== undefined) patch.is_active = !!body.is_active
  if (body.priority !== undefined) patch.priority = Number(body.priority) || 100
  if (body.conditions !== undefined)
    patch.conditions = Array.isArray(body.conditions) ? body.conditions : []
  if (body.match_mode !== undefined)
    patch.match_mode = body.match_mode === 'any' ? 'any' : 'all'
  if (body.set_priority !== undefined) patch.set_priority = body.set_priority || null
  if (body.set_status !== undefined) patch.set_status = body.set_status || null
  if (body.add_tags !== undefined)
    patch.add_tags = Array.isArray(body.add_tags) ? body.add_tags.filter(Boolean) : null
  if (body.assign_to_team !== undefined)
    patch.assign_to_team = body.assign_to_team || null
  if (body.assign_to_user !== undefined)
    patch.assign_to_user = body.assign_to_user || null
  if (body.use_round_robin !== undefined)
    patch.use_round_robin = !!body.use_round_robin
  if (body.account_id !== undefined) patch.account_id = body.account_id || null
  return patch
}

export async function GET() {
  const gate = await requireAdmin()
  if (!gate.ok) return NextResponse.json({ error: gate.error }, { status: gate.status })

  const admin = await createServiceRoleClient()
  const { data, error } = await admin
    .from('routing_rules')
    .select('*')
    .order('priority', { ascending: true })
    .order('created_at', { ascending: false })

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
  return NextResponse.json({ rules: data || [] })
}

export async function POST(request: Request) {
  const gate = await requireAdmin()
  if (!gate.ok) return NextResponse.json({ error: gate.error }, { status: gate.status })

  let body: RuleBody
  try {
    body = (await request.json()) as RuleBody
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  if (!body.name || typeof body.name !== 'string' || !body.name.trim()) {
    return NextResponse.json({ error: 'name is required' }, { status: 400 })
  }

  const patch = sanitizeBody(body)
  patch.created_by = gate.userId
  if (patch.priority === undefined) patch.priority = 100
  if (patch.match_mode === undefined) patch.match_mode = 'all'
  if (patch.is_active === undefined) patch.is_active = true
  if (patch.use_round_robin === undefined) patch.use_round_robin = false

  const admin = await createServiceRoleClient()
  const { data, error } = await admin
    .from('routing_rules')
    .insert(patch)
    .select('*')
    .single()

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
  return NextResponse.json({ rule: data }, { status: 201 })
}

export async function PATCH(request: Request) {
  const gate = await requireAdmin()
  if (!gate.ok) return NextResponse.json({ error: gate.error }, { status: gate.status })

  const url = new URL(request.url)
  const id = url.searchParams.get('id')
  if (!id) return NextResponse.json({ error: 'id query param required' }, { status: 400 })

  let body: RuleBody
  try {
    body = (await request.json()) as RuleBody
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const patch = sanitizeBody(body)
  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: 'no fields to update' }, { status: 400 })
  }

  const admin = await createServiceRoleClient()
  const { data, error } = await admin
    .from('routing_rules')
    .update(patch)
    .eq('id', id)
    .select('*')
    .single()

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
  return NextResponse.json({ rule: data })
}

export async function DELETE(request: Request) {
  const gate = await requireAdmin()
  if (!gate.ok) return NextResponse.json({ error: gate.error }, { status: gate.status })

  const url = new URL(request.url)
  const id = url.searchParams.get('id')
  if (!id) return NextResponse.json({ error: 'id query param required' }, { status: 400 })

  const admin = await createServiceRoleClient()
  const { error } = await admin.from('routing_rules').delete().eq('id', id)
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
  return NextResponse.json({ ok: true })
}
