// CRUD for `public.saved_views` — user-scoped smart inboxes. Session-auth only.
//
// GET   /api/saved-views          → list user's own + shared views, ordered by sort_order, created_at
// POST  /api/saved-views          → create view (user_id = current user)
// PATCH /api/saved-views          → update view (owner OR admin)
//
// View `filters` is a JSONB blob of UI-only filter fields (see
// SavedViewFilters in `@/types/database`). The server doesn't apply them —
// the inbox client reads + applies them when navigating to ?view=ID.

import { NextResponse } from 'next/server'
import {
  createServerSupabaseClient,
  createServiceRoleClient,
} from '@/lib/supabase-server'
import type { SavedViewFilters } from '@/types/database'

interface SavedViewBody {
  id?: string
  name?: string
  icon?: string | null
  filters?: SavedViewFilters
  is_shared?: boolean
  sort_order?: number
}

// Whitelist for filter keys we'll accept from clients. Anything else is dropped.
const ALLOWED_FILTER_KEYS: ReadonlySet<keyof SavedViewFilters> = new Set([
  'channel',
  'account_ids',
  'status',
  'priority',
  'sentiment',
  'category',
  'assignee',
  'age_hours_gt',
  'search',
  'unread_only',
])

function sanitizeFilters(input: unknown): SavedViewFilters {
  if (!input || typeof input !== 'object') return {}
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (!ALLOWED_FILTER_KEYS.has(key as keyof SavedViewFilters)) continue
    if (value === undefined || value === null) continue
    if (key === 'account_ids') {
      if (Array.isArray(value)) {
        out[key] = value.filter((v) => typeof v === 'string')
      }
      continue
    }
    if (key === 'age_hours_gt') {
      const n = Number(value)
      if (Number.isFinite(n) && n > 0) out[key] = n
      continue
    }
    if (key === 'unread_only') {
      out[key] = !!value
      continue
    }
    if (typeof value === 'string') out[key] = value
  }
  return out as SavedViewFilters
}

async function getSession(): Promise<
  | { ok: true; userId: string; isAdmin: boolean }
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
  return { ok: true, userId: user.id, isAdmin: profile?.role === 'admin' }
}

export async function GET() {
  const gate = await getSession()
  if (!gate.ok) return NextResponse.json({ error: gate.error }, { status: gate.status })

  const admin = await createServiceRoleClient()
  // Admins see everything, regular users see own + shared. RLS would handle
  // this on the client too, but we go through service-role for consistency.
  const query = admin
    .from('saved_views')
    .select('id, user_id, name, icon, filters, is_shared, sort_order, created_at')
    .order('sort_order', { ascending: true })
    .order('created_at', { ascending: true })

  const { data, error } = gate.isAdmin
    ? await query
    : await query.or(`user_id.eq.${gate.userId},is_shared.eq.true`)

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
  return NextResponse.json({ views: data || [] })
}

export async function POST(request: Request) {
  const gate = await getSession()
  if (!gate.ok) return NextResponse.json({ error: gate.error }, { status: gate.status })

  let body: SavedViewBody
  try {
    body = (await request.json()) as SavedViewBody
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const name = typeof body.name === 'string' ? body.name.trim() : ''
  if (!name) return NextResponse.json({ error: 'name is required' }, { status: 400 })

  const insert = {
    user_id: gate.userId,
    name: name.slice(0, 100),
    icon: typeof body.icon === 'string' ? body.icon.slice(0, 50) : null,
    filters: sanitizeFilters(body.filters),
    is_shared: !!body.is_shared,
    sort_order: Number.isFinite(body.sort_order) ? Number(body.sort_order) : 0,
  }

  const admin = await createServiceRoleClient()
  const { data, error } = await admin
    .from('saved_views')
    .insert(insert)
    .select('id, user_id, name, icon, filters, is_shared, sort_order, created_at')
    .single()

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
  return NextResponse.json({ view: data }, { status: 201 })
}

export async function PATCH(request: Request) {
  const gate = await getSession()
  if (!gate.ok) return NextResponse.json({ error: gate.error }, { status: gate.status })

  let body: SavedViewBody
  try {
    body = (await request.json()) as SavedViewBody
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const id = body.id
  if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 })

  const admin = await createServiceRoleClient()
  const { data: existing } = await admin
    .from('saved_views')
    .select('id, user_id')
    .eq('id', id)
    .maybeSingle()
  if (!existing) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }
  if (existing.user_id !== gate.userId && !gate.isAdmin) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const patch: Record<string, unknown> = {}
  if (body.name !== undefined) {
    const name = String(body.name).trim()
    if (!name) return NextResponse.json({ error: 'name cannot be empty' }, { status: 400 })
    patch.name = name.slice(0, 100)
  }
  if (body.icon !== undefined) {
    patch.icon = body.icon === null ? null : String(body.icon).slice(0, 50)
  }
  if (body.filters !== undefined) patch.filters = sanitizeFilters(body.filters)
  if (body.is_shared !== undefined) patch.is_shared = !!body.is_shared
  if (body.sort_order !== undefined) patch.sort_order = Number(body.sort_order) || 0

  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: 'no fields to update' }, { status: 400 })
  }

  const { data, error } = await admin
    .from('saved_views')
    .update(patch)
    .eq('id', id)
    .select('id, user_id, name, icon, filters, is_shared, sort_order, created_at')
    .single()

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
  return NextResponse.json({ view: data })
}
