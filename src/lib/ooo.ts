// Per-account Out-of-Office (OOO) auto-reply helpers.
//
// Pure helpers that the email + Teams ingest pipelines call to decide
// whether to send an automatic reply when an account is out of office,
// and a tiny variable-substitution helper for the OOO body/subject text.
//
// Dedup: we only auto-reply ONCE per conversation per OOO window. The
// window is keyed by `accounts.ooo_starts_at` so toggling OOO off and
// back on with a fresh start time gives every conversation a clean slate.
//
// Window math: an OOO window can be open-ended on either side. Missing
// `ooo_starts_at` means "started in the indefinite past"; missing
// `ooo_ends_at` means "no scheduled return". Both null = always-on while
// `ooo_enabled=true`. Inclusive on both ends.

import type { SupabaseClient } from '@supabase/supabase-js'

// ─── Types ───────────────────────────────────────────────────────────

/** The minimal subset of `accounts` row needed to evaluate OOO state. */
export interface OOOAccount {
  ooo_enabled?: boolean | null
  ooo_starts_at?: string | null
  ooo_ends_at?: string | null
  ooo_subject?: string | null
  ooo_body?: string | null
}

export interface OOOContext {
  customer?: { name?: string | null; email?: string | null } | null
  company?: { name?: string | null } | null
  /** Used to render `{{ooo.return_date}}`. */
  ooo?: { ends_at?: string | null } | null
}

// ─── Window check ────────────────────────────────────────────────────

/**
 * Returns true if the account is currently in its configured OOO window.
 *
 * Open-ended windows are supported on either side:
 *   - no `ooo_starts_at` → window started in the indefinite past
 *   - no `ooo_ends_at`   → no scheduled return
 *
 * Both bounds are inclusive (compared with `<=` against `now`).
 *
 * `ooo_enabled` must also be true — disabling OOO short-circuits the check
 * regardless of the dates so admins can flip it off without clearing the
 * date fields.
 *
 * @param account  Subset of an `accounts` row with the OOO columns.
 * @param now      Override for "current time" so tests are deterministic.
 *                 Defaults to `new Date()`.
 */
export function isAccountOOO(account: OOOAccount, now: Date = new Date()): boolean {
  if (!account.ooo_enabled) return false
  const t = now.getTime()
  if (account.ooo_starts_at) {
    const start = Date.parse(account.ooo_starts_at)
    if (Number.isFinite(start) && t < start) return false
  }
  if (account.ooo_ends_at) {
    const end = Date.parse(account.ooo_ends_at)
    if (Number.isFinite(end) && t > end) return false
  }
  return true
}

// ─── Dedup ───────────────────────────────────────────────────────────

/**
 * Returns true if we have NOT already sent an OOO auto-reply for this
 * conversation in the current OOO window.
 *
 * The dedup row is keyed by `(conversation_id, ooo_window_start)`. The
 * window-start value is treated as the `accounts.ooo_starts_at` at the
 * time of send — callers should pass the same string they use to record
 * the dedup row so the lookup matches exactly.
 *
 * `null`/empty `windowStart` is normalised to the canonical sentinel
 * `'epoch'` (1970-01-01T00:00:00Z) so an open-ended OOO window (no start
 * date) still has a stable dedup key.
 */
export async function shouldSendOOOReply(
  supabase: SupabaseClient,
  accountId: string,
  conversationId: string,
  windowStart: string | null
): Promise<boolean> {
  if (!accountId || !conversationId) return false
  const key = normaliseWindowStart(windowStart)
  const { data, error } = await supabase
    .from('ooo_replies_sent')
    .select('id')
    .eq('conversation_id', conversationId)
    .eq('ooo_window_start', key)
    .limit(1)
    .maybeSingle()
  if (error) {
    // Fail closed on lookup error — better to skip an auto-reply than to
    // spam the customer with a duplicate. The caller logs the skip.
    return false
  }
  return data == null
}

/**
 * Insert the dedup row that prevents subsequent inbound messages from
 * triggering another OOO reply during the same window. Uses the unique
 * index `uniq_ooo_per_conv_per_window` so concurrent inserts collapse to
 * a single row. Returns `true` on insert, `false` if a row already
 * existed (race) or the write errored.
 */
export async function recordOOOReply(
  supabase: SupabaseClient,
  accountId: string,
  conversationId: string,
  windowStart: string | null
): Promise<boolean> {
  if (!accountId || !conversationId) return false
  const key = normaliseWindowStart(windowStart)
  const { error } = await supabase.from('ooo_replies_sent').insert({
    account_id: accountId,
    conversation_id: conversationId,
    ooo_window_start: key,
  })
  if (error) return false
  return true
}

/**
 * Canonicalise the window-start key. NULL/empty becomes the unix epoch
 * so the unique index still has a stable value to dedupe on.
 */
function normaliseWindowStart(value: string | null | undefined): string {
  if (!value) return '1970-01-01T00:00:00.000Z'
  // Keep ISO format consistent — Postgres stores timestamptz uniformly
  // but the comparison is text-equality through the eq() filter.
  const t = Date.parse(value)
  if (!Number.isFinite(t)) return '1970-01-01T00:00:00.000Z'
  return new Date(t).toISOString()
}

// ─── Variable substitution ──────────────────────────────────────────

/**
 * Render `{{customer.name}}`, `{{ooo.return_date}}`, and `{{company.name}}`
 * inside the supplied text. Any unknown variable is left untouched.
 *
 * Sanitisation matches `lib/templates.ts`: HTML tags, markdown link/image
 * syntax, and backticks are stripped from substituted values so a customer
 * display name can't smuggle clickable links into the auto-reply.
 *
 * `{{ooo.return_date}}` formats `ctx.ooo.ends_at` as `yyyy-mm-dd` in the
 * machine's local timezone. Renders empty string when the end date is
 * not set (open-ended OOO).
 */
export function substituteOOOVariables(text: string, ctx: OOOContext): string {
  if (!text) return ''
  return text.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (full, name: string) => {
    switch (name) {
      case 'customer.name':
        return sanitise(ctx.customer?.name ?? ctx.customer?.email ?? '')
      case 'customer.email':
        return sanitise(ctx.customer?.email ?? '')
      case 'company.name':
        return sanitise(ctx.company?.name ?? '')
      case 'ooo.return_date': {
        const raw = ctx.ooo?.ends_at
        if (!raw) return ''
        const t = Date.parse(raw)
        if (!Number.isFinite(t)) return ''
        const d = new Date(t)
        const yyyy = d.getFullYear()
        const mm = String(d.getMonth() + 1).padStart(2, '0')
        const dd = String(d.getDate()).padStart(2, '0')
        return `${yyyy}-${mm}-${dd}`
      }
      default:
        return full
    }
  })
}

function sanitise(raw: unknown): string {
  if (raw === null || raw === undefined) return ''
  let s = String(raw)
  s = s.replace(/<[^>]*>/g, '')
  s = s.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
  s = s.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
  s = s.replace(/`/g, '')
  // eslint-disable-next-line no-control-regex
  s = s.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
  return s.trim()
}

// Variable list re-exported so the admin UI can render a hint chip palette
// without duplicating the source of truth.
export const OOO_VARIABLES: ReadonlyArray<string> = [
  'customer.name',
  'ooo.return_date',
  'company.name',
] as const
