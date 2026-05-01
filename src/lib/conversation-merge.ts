// ─── Conversation merging helpers ──────────────────────────────────────
//
// "Merge" means: when the same person reaches out from two addresses (e.g.
// aman@mcm.com and aman@gmail.com) or via two channels, an agent can collapse
// the secondary conversation INTO the primary one. We do this as a SOFT merge:
//
//   1. Re-point messages.conversation_id from secondary → primary
//   2. Mark the secondary row with merged_into_id / merged_at / merged_by
//   3. Insert an audit row in conversation_merges capturing the moved ids
//      so unmerge can reverse the operation deterministically
//
// The actual mutation runs inside the `merge_conversations(...)` RPC (SECURITY
// DEFINER + plpgsql) so the multi-statement update is wrapped in a single
// PostgREST transaction — no half-merged states if one statement fails.
//
// Auth + cross-company scoping are enforced by the calling Next.js route
// (`verifyAccountAccess` on both conversations); the RPC itself only checks
// structural invariants (no self-merge, no double-merge, both rows exist,
// company-scoped rows match).

import type { SupabaseClient } from '@supabase/supabase-js'

// ─── Types ──────────────────────────────────────────────────────────

export interface MergePreview {
  primary: {
    id: string
    participant_name: string | null
    participant_email: string | null
    channel: string
    message_count: number
    first_message_at: string | null
    last_message_at: string | null
  }
  secondary: {
    id: string
    participant_name: string | null
    participant_email: string | null
    channel: string
    message_count: number
    first_message_at: string | null
    last_message_at: string | null
  }
  /** Sum of both conversations' message counts. */
  combined_message_count: number
  /** Earliest first_message_at across both. */
  combined_first_message_at: string | null
  /** Latest last_message_at across both. */
  combined_last_message_at: string | null
  /** True when neither side is already merged (i.e. merge is allowed). */
  allowed: boolean
  /** Human-readable reason when `allowed` is false. */
  blocked_reason: string | null
}

export interface MergeResult {
  audit_id: string
  primary_conversation_id: string
  secondary_conversation_id: string
  message_ids: string[]
  merged_at: string
}

export interface MergeCandidate {
  id: string
  channel: string
  participant_name: string | null
  participant_email: string | null
  participant_phone: string | null
  message_count: number
  last_message_at: string | null
  /** First inbound message's preview text (truncated). Helpful in the picker. */
  preview: string | null
}

// ─── Helpers ────────────────────────────────────────────────────────

/** Trim/normalize a preview string for the merge picker. */
function makePreview(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const cleaned = raw.replace(/\s+/g, ' ').trim()
  if (!cleaned) return null
  return cleaned.length > 120 ? cleaned.slice(0, 117) + '…' : cleaned
}

/**
 * Build a safe MergePreview from two conversation ids. Does NOT write anything.
 * Returns null if either conversation does not exist.
 *
 * The calling route is responsible for auth-gating BOTH ids before invoking
 * this function — this helper trusts the supplied client to be appropriately
 * scoped (or service-role with prior access checks).
 */
export async function previewMerge(
  client: SupabaseClient,
  primaryId: string,
  secondaryId: string,
): Promise<MergePreview | null> {
  if (!primaryId || !secondaryId) return null
  if (primaryId === secondaryId) {
    return null
  }

  const { data: rows, error } = await client
    .from('conversations')
    .select(
      'id, participant_name, participant_email, channel, first_message_at, last_message_at, merged_into_id'
    )
    .in('id', [primaryId, secondaryId])

  if (error) throw new Error(`previewMerge: ${error.message}`)
  if (!rows || rows.length !== 2) return null

  const primary = rows.find((r: any) => r.id === primaryId)
  const secondary = rows.find((r: any) => r.id === secondaryId)
  if (!primary || !secondary) return null

  // Per-side message counts.
  const [primaryCount, secondaryCount] = await Promise.all([
    client
      .from('messages')
      .select('id', { count: 'exact', head: true })
      .eq('conversation_id', primaryId),
    client
      .from('messages')
      .select('id', { count: 'exact', head: true })
      .eq('conversation_id', secondaryId),
  ])
  const pCount = primaryCount.count ?? 0
  const sCount = secondaryCount.count ?? 0

  // Compute the allowed flag + reason.
  let allowed = true
  let blockedReason: string | null = null
  if (primary.merged_into_id) {
    allowed = false
    blockedReason = 'Primary conversation is already merged into another conversation'
  } else if (secondary.merged_into_id) {
    allowed = false
    blockedReason = 'Secondary conversation is already merged'
  }

  const firstAts = [primary.first_message_at, secondary.first_message_at].filter(
    (v): v is string => typeof v === 'string'
  )
  const lastAts = [primary.last_message_at, secondary.last_message_at].filter(
    (v): v is string => typeof v === 'string'
  )
  const combinedFirst =
    firstAts.length > 0
      ? firstAts.reduce((acc, v) => (acc < v ? acc : v))
      : null
  const combinedLast =
    lastAts.length > 0
      ? lastAts.reduce((acc, v) => (acc > v ? acc : v))
      : null

  return {
    primary: {
      id: primary.id,
      participant_name: primary.participant_name ?? null,
      participant_email: primary.participant_email ?? null,
      channel: primary.channel,
      message_count: pCount,
      first_message_at: primary.first_message_at ?? null,
      last_message_at: primary.last_message_at ?? null,
    },
    secondary: {
      id: secondary.id,
      participant_name: secondary.participant_name ?? null,
      participant_email: secondary.participant_email ?? null,
      channel: secondary.channel,
      message_count: sCount,
      first_message_at: secondary.first_message_at ?? null,
      last_message_at: secondary.last_message_at ?? null,
    },
    combined_message_count: pCount + sCount,
    combined_first_message_at: combinedFirst,
    combined_last_message_at: combinedLast,
    allowed,
    blocked_reason: blockedReason,
  }
}

/**
 * Perform the merge. Atomic: the underlying RPC re-points messages, marks the
 * secondary, updates the primary's last_message_at, and inserts the audit row
 * inside a single transaction. Throws on validation failure (self-merge, double
 * merge, missing rows, cross-company).
 *
 * Returns the audit row from `conversation_merges`.
 */
export async function mergeConversations(
  client: SupabaseClient,
  primaryId: string,
  secondaryId: string,
  userId: string | null,
): Promise<MergeResult> {
  if (!primaryId || !secondaryId) {
    throw new Error('mergeConversations: both ids are required')
  }
  if (primaryId === secondaryId) {
    throw new Error('mergeConversations: primary and secondary cannot be the same')
  }

  const { data, error } = await client.rpc('merge_conversations', {
    p_primary_id: primaryId,
    p_secondary_id: secondaryId,
    p_user_id: userId,
  })
  if (error) {
    throw new Error(`mergeConversations: ${error.message}`)
  }
  // PostgREST returns the function result; for a function returning a single
  // composite ROW it surfaces as an object on `data`.
  const row = (Array.isArray(data) ? data[0] : data) as
    | {
        id: string
        primary_conversation_id: string
        secondary_conversation_id: string
        message_ids: string[]
        merged_at: string
      }
    | null
  if (!row) {
    throw new Error('mergeConversations: RPC returned no row')
  }
  return {
    audit_id: row.id,
    primary_conversation_id: row.primary_conversation_id,
    secondary_conversation_id: row.secondary_conversation_id,
    message_ids: row.message_ids ?? [],
    merged_at: row.merged_at,
  }
}

/**
 * Reverse a previous merge. Looks up the most recent active audit row for the
 * pair, moves only the message ids it recorded back onto the secondary, and
 * clears the secondary's merged_* fields.
 *
 * Returns the (now closed) audit row.
 */
export async function unmergeConversations(
  client: SupabaseClient,
  primaryId: string,
  secondaryId: string,
  userId: string | null,
): Promise<MergeResult> {
  if (!primaryId || !secondaryId) {
    throw new Error('unmergeConversations: both ids are required')
  }
  const { data, error } = await client.rpc('unmerge_conversations', {
    p_primary_id: primaryId,
    p_secondary_id: secondaryId,
    p_user_id: userId,
  })
  if (error) {
    throw new Error(`unmergeConversations: ${error.message}`)
  }
  const row = (Array.isArray(data) ? data[0] : data) as
    | {
        id: string
        primary_conversation_id: string
        secondary_conversation_id: string
        message_ids: string[]
        merged_at: string
        unmerged_at: string | null
      }
    | null
  if (!row) {
    throw new Error('unmergeConversations: RPC returned no row')
  }
  return {
    audit_id: row.id,
    primary_conversation_id: row.primary_conversation_id,
    secondary_conversation_id: row.secondary_conversation_id,
    message_ids: row.message_ids ?? [],
    merged_at: row.merged_at,
  }
}

/**
 * Find up to `limit` other conversations that look like they belong to the
 * same person — same `participant_email`, same `participant_phone`, or the
 * same `contact_id` if linked. Excludes:
 *   - the conversation itself
 *   - already-merged secondaries (merged_into_id is not null)
 *
 * Result is ordered by last_message_at DESC and includes a short preview from
 * the first inbound message so the picker can show useful context.
 */
export async function findMergeCandidates(
  client: SupabaseClient,
  conversationId: string,
  limit = 5,
): Promise<MergeCandidate[]> {
  if (!conversationId) return []

  const { data: source, error: srcErr } = await client
    .from('conversations')
    .select('id, participant_email, participant_phone, contact_id')
    .eq('id', conversationId)
    .maybeSingle()
  if (srcErr || !source) return []

  // Build the OR filter. PostgREST `.or()` takes a comma-separated string with
  // the column.op.value form. Include each non-null source key.
  const orParts: string[] = []
  if (source.participant_email) {
    orParts.push(`participant_email.eq.${source.participant_email}`)
  }
  if (source.participant_phone) {
    orParts.push(`participant_phone.eq.${source.participant_phone}`)
  }
  if (source.contact_id) {
    orParts.push(`contact_id.eq.${source.contact_id}`)
  }
  if (orParts.length === 0) return []

  const { data: candidates, error: candErr } = await client
    .from('conversations')
    .select(
      'id, channel, participant_name, participant_email, participant_phone, last_message_at, merged_into_id'
    )
    .or(orParts.join(','))
    .neq('id', conversationId)
    .is('merged_into_id', null)
    .order('last_message_at', { ascending: false })
    .limit(Math.max(1, Math.min(limit, 25)))

  if (candErr || !candidates) return []

  const ids = candidates.map((c: any) => c.id as string)
  if (ids.length === 0) return []

  // Pull message counts + first-inbound preview for each candidate. Two cheap
  // round-trips beats N+1; the candidate set is bounded to `limit` (<=25).
  const [{ data: counts }, { data: previews }] = await Promise.all([
    client
      .from('messages')
      .select('conversation_id')
      .in('conversation_id', ids),
    client
      .from('messages')
      .select('conversation_id, message_text, email_subject, direction, timestamp')
      .in('conversation_id', ids)
      .eq('direction', 'inbound')
      .order('timestamp', { ascending: true }),
  ])

  const countMap = new Map<string, number>()
  for (const r of counts ?? []) {
    const cid = (r as { conversation_id: string }).conversation_id
    countMap.set(cid, (countMap.get(cid) ?? 0) + 1)
  }
  const previewMap = new Map<string, string | null>()
  for (const r of previews ?? []) {
    const row = r as {
      conversation_id: string
      message_text: string | null
      email_subject: string | null
    }
    if (previewMap.has(row.conversation_id)) continue
    previewMap.set(
      row.conversation_id,
      makePreview(row.email_subject || row.message_text)
    )
  }

  return candidates.map((c: any) => ({
    id: c.id,
    channel: c.channel,
    participant_name: c.participant_name ?? null,
    participant_email: c.participant_email ?? null,
    participant_phone: c.participant_phone ?? null,
    message_count: countMap.get(c.id) ?? 0,
    last_message_at: c.last_message_at ?? null,
    preview: previewMap.get(c.id) ?? null,
  }))
}
