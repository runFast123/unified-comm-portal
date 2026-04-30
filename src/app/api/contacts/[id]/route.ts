import { NextResponse } from 'next/server'

import { logAudit } from '@/lib/audit'
import { createServerSupabaseClient, createServiceRoleClient } from '@/lib/supabase-server'

interface ContactPatchBody {
  display_name?: unknown
  notes?: unknown
  tags?: unknown
  is_vip?: unknown
}

interface ValidatedPatch {
  display_name?: string | null
  notes?: string | null
  tags?: string[]
  is_vip?: boolean
}

function validatePatch(body: ContactPatchBody): { ok: true; patch: ValidatedPatch } | { ok: false; error: string } {
  const patch: ValidatedPatch = {}

  if ('display_name' in body) {
    if (body.display_name === null) {
      patch.display_name = null
    } else if (typeof body.display_name === 'string') {
      patch.display_name = body.display_name.trim() || null
    } else {
      return { ok: false, error: 'display_name must be a string or null' }
    }
  }

  if ('notes' in body) {
    if (body.notes === null) {
      patch.notes = null
    } else if (typeof body.notes === 'string') {
      patch.notes = body.notes
    } else {
      return { ok: false, error: 'notes must be a string or null' }
    }
  }

  if ('tags' in body) {
    if (!Array.isArray(body.tags) || body.tags.some((t) => typeof t !== 'string')) {
      return { ok: false, error: 'tags must be an array of strings' }
    }
    // Dedupe + trim, drop empties.
    const seen = new Set<string>()
    const cleaned: string[] = []
    for (const raw of body.tags as string[]) {
      const t = raw.trim()
      if (t.length === 0) continue
      const key = t.toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      cleaned.push(t)
    }
    patch.tags = cleaned
  }

  if ('is_vip' in body) {
    if (typeof body.is_vip !== 'boolean') {
      return { ok: false, error: 'is_vip must be a boolean' }
    }
    patch.is_vip = body.is_vip
  }

  if (Object.keys(patch).length === 0) {
    return { ok: false, error: 'No valid fields to update' }
  }

  return { ok: true, patch }
}

/**
 * PATCH /api/contacts/:id — partial update for display_name, notes, tags, is_vip.
 * Session-auth (any signed-in user). Mutations are audit-logged.
 */
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params
    if (!id) return NextResponse.json({ error: 'Missing id' }, { status: 400 })

    const supabase = await createServerSupabaseClient()
    const {
      data: { user },
    } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const body = (await request.json().catch(() => null)) as ContactPatchBody | null
    if (!body || typeof body !== 'object') {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }

    const validation = validatePatch(body)
    if (!validation.ok) {
      return NextResponse.json({ error: validation.error }, { status: 400 })
    }

    const admin = await createServiceRoleClient()

    const { data: existing } = await admin
      .from('contacts')
      .select('id')
      .eq('id', id)
      .maybeSingle()
    if (!existing) {
      return NextResponse.json({ error: 'Contact not found' }, { status: 404 })
    }

    const { data: updated, error } = await admin
      .from('contacts')
      .update(validation.patch)
      .eq('id', id)
      .select(
        'id, email, phone, display_name, notes, tags, first_seen_at, last_seen_at, total_conversations, is_vip'
      )
      .single()
    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    void logAudit({
      user_id: user.id,
      action: 'contact_updated',
      entity_type: 'contact',
      entity_id: id,
      details: { fields: Object.keys(validation.patch) },
    })

    return NextResponse.json({ contact: updated })
  } catch (err) {
    console.error('Contacts PATCH error:', err)
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Internal error' },
      { status: 500 }
    )
  }
}

/**
 * DELETE /api/contacts/:id — admin-only hard delete.
 * The conversations.contact_id FK is set to ON DELETE SET NULL by the
 * migration that added it, so existing conversations are preserved with
 * their `contact_id` cleared.
 */
export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params
    if (!id) return NextResponse.json({ error: 'Missing id' }, { status: 400 })

    const supabase = await createServerSupabaseClient()
    const {
      data: { user },
    } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const admin = await createServiceRoleClient()
    const { data: profile } = await admin
      .from('users')
      .select('role')
      .eq('id', user.id)
      .maybeSingle()
    if (profile?.role !== 'admin') {
      return NextResponse.json({ error: 'Forbidden: admin only' }, { status: 403 })
    }

    const { data: existing } = await admin
      .from('contacts')
      .select('id, email, phone, display_name')
      .eq('id', id)
      .maybeSingle()
    if (!existing) {
      return NextResponse.json({ error: 'Contact not found' }, { status: 404 })
    }

    const { error } = await admin.from('contacts').delete().eq('id', id)
    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    void logAudit({
      user_id: user.id,
      action: 'contact_deleted',
      entity_type: 'contact',
      entity_id: id,
      details: {
        email: existing.email,
        phone: existing.phone,
        display_name: existing.display_name,
      },
    })

    return NextResponse.json({ success: true })
  } catch (err) {
    console.error('Contacts DELETE error:', err)
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Internal error' },
      { status: 500 }
    )
  }
}
