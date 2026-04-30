import type { SupabaseClient } from '@supabase/supabase-js'

import type { Contact } from '@/types/database'

export type { Contact }

interface FindOrCreateContactParams {
  email?: string | null
  phone?: string | null
  display_name?: string | null
}

function normaliseEmail(email: string | null | undefined): string | null {
  if (!email) return null
  const trimmed = email.trim().toLowerCase()
  return trimmed.length > 0 ? trimmed : null
}

function normalisePhone(phone: string | null | undefined): string | null {
  if (!phone) return null
  const trimmed = phone.trim()
  return trimmed.length > 0 ? trimmed : null
}

/**
 * Find a contact by email or phone, or create one. Updates `last_seen_at` and
 * increments `total_conversations` for an existing contact. Returns the
 * contact id, or null if neither identifier was provided.
 *
 * Lookup order:
 *   1. email (lowercase normalized) — preferred when present
 *   2. phone (trimmed) — fallback
 *
 * Race-condition safety: a parallel webhook may insert the same row between
 * our SELECT and INSERT. We surface that as a 23505 unique-violation and
 * retry the lookup, returning whichever row won.
 *
 * Designed to be best-effort — callers should wrap in try/catch so a contact
 * write failure never blocks the inbound conversation/message ingest.
 */
export async function findOrCreateContact(
  supabase: SupabaseClient,
  params: FindOrCreateContactParams
): Promise<string | null> {
  const email = normaliseEmail(params.email)
  const phone = normalisePhone(params.phone)
  if (!email && !phone) return null

  const display_name = params.display_name?.trim() || null

  // 1. Lookup by email first (it's the stronger identifier in our schema —
  //    has a unique lower() index). Fall back to phone when no email match.
  const lookup = await lookupContact(supabase, email, phone)
  if (lookup) {
    await touchContact(supabase, lookup.id, lookup.total_conversations)
    return lookup.id
  }

  // 2. Insert. Use the now() default for first_seen_at / last_seen_at and
  //    seed total_conversations at 1 since this insert is paired with a
  //    fresh inbound conversation.
  const nowIso = new Date().toISOString()
  const { data: inserted, error } = await supabase
    .from('contacts')
    .insert({
      email,
      phone,
      display_name,
      tags: [],
      first_seen_at: nowIso,
      last_seen_at: nowIso,
      total_conversations: 1,
      is_vip: false,
    })
    .select('id')
    .single()

  if (inserted?.id) return inserted.id

  // 3. Race recovery — a parallel insert won. Re-fetch and bump.
  const code = (error as { code?: string } | null)?.code
  const isUniqueViolation =
    code === '23505' || /duplicate key|unique constraint/i.test(error?.message || '')
  if (isUniqueViolation) {
    const winner = await lookupContact(supabase, email, phone)
    if (winner) {
      await touchContact(supabase, winner.id, winner.total_conversations)
      return winner.id
    }
  }

  // Unknown failure — let the caller decide via the thrown error. Wrapping
  // in try/catch at the call site keeps the inbound flow alive.
  if (error) {
    throw new Error(`findOrCreateContact insert failed: ${error.message}`)
  }
  return null
}

async function lookupContact(
  supabase: SupabaseClient,
  email: string | null,
  phone: string | null
): Promise<Pick<Contact, 'id' | 'total_conversations'> | null> {
  if (email) {
    const { data } = await supabase
      .from('contacts')
      .select('id, total_conversations')
      .eq('email', email)
      .limit(1)
      .maybeSingle()
    if (data) return data as Pick<Contact, 'id' | 'total_conversations'>
  }
  if (phone) {
    const { data } = await supabase
      .from('contacts')
      .select('id, total_conversations')
      .eq('phone', phone)
      .limit(1)
      .maybeSingle()
    if (data) return data as Pick<Contact, 'id' | 'total_conversations'>
  }
  return null
}

async function touchContact(
  supabase: SupabaseClient,
  id: string,
  currentTotal: number
): Promise<void> {
  // Plain UPDATE — atomicity isn't critical here since the worst case is a
  // missed +1 on a contention race. Using a stored increment would be nicer
  // but the helper is intentionally minimal.
  await supabase
    .from('contacts')
    .update({
      last_seen_at: new Date().toISOString(),
      total_conversations: (currentTotal ?? 0) + 1,
    })
    .eq('id', id)
}
