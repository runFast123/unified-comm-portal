/**
 * Email signature resolver with two-level inheritance.
 *
 *   1. Per-user signature (`users.email_signature`) wins when set AND
 *      `users.email_signature_enabled` is true.
 *   2. Otherwise the company-wide default
 *      (`companies.default_email_signature` via the user's account ->
 *      account.company_id) is used.
 *   3. Otherwise the user has opted out / nothing is configured -> null.
 *
 * The resolved signature is returned as raw markdown — callers decide
 * plain-text vs HTML rendering. Variable substitution
 * (`{{user.full_name}}`, `{{user.email}}`, `{{company.name}}`, `{{date}}`)
 * is performed before returning so the same string can be appended verbatim.
 */

/** Minimal shape of the supabase client used by this module — typed loosely so
 *  it accepts both the SSR helper output and the service-role client without
 *  pulling in the full PostgrestQueryBuilder generics. The runtime contract
 *  is just "has a `from(table)` that supports `.select().eq().maybeSingle()`". */
export type SignatureSupabase = {
  from: (table: string) => unknown
}

export interface SignatureContext {
  user: {
    id: string
    full_name: string | null
    email: string | null
  }
  company: {
    name: string | null
  }
  /** ISO date string used for the {{date}} variable. Defaults to today's
   *  locale-formatted date. Exposed for deterministic tests. */
  date: string
}

/**
 * Substitute the supported `{{...}}` variables inside a signature string.
 * Unknown placeholders are left untouched so a typo doesn't silently delete
 * content; the variable list is intentionally small and explicit.
 */
export function substituteSignatureVariables(
  template: string,
  ctx: SignatureContext,
): string {
  if (!template) return template
  // Build a static map; unrecognized keys fall through.
  const lookup: Record<string, string> = {
    'user.full_name': ctx.user.full_name ?? '',
    'user.email': ctx.user.email ?? '',
    'company.name': ctx.company.name ?? '',
    date: ctx.date,
  }
  return template.replace(/\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g, (match, key: string) => {
    const k = key.trim()
    if (Object.prototype.hasOwnProperty.call(lookup, k)) return lookup[k]
    return match
  })
}

/**
 * Decide which template (user vs company) applies. Pulled out of
 * `resolveSignature` so unit tests can pin the inheritance rules without
 * mocking the database.
 *
 * @returns the resolved raw template, or null when neither layer applies.
 */
export function pickSignatureTemplate(input: {
  user_signature: string | null | undefined
  user_signature_enabled: boolean | null | undefined
  company_default: string | null | undefined
}): string | null {
  const userSig = input.user_signature?.trim() ?? ''
  const userEnabled = input.user_signature_enabled !== false // default true
  if (userEnabled && userSig.length > 0) return input.user_signature ?? null
  const companySig = input.company_default?.trim() ?? ''
  if (companySig.length > 0) return input.company_default ?? null
  return null
}

/**
 * Render a signature for `userId`. Returns the variable-substituted markdown
 * string ready to append to an outbound email body, or null if the user has
 * disabled signatures and the company has no default configured.
 *
 * Implementation:
 *   - One query joins `users.email_signature, email_signature_enabled,
 *     full_name, email, account_id`.
 *   - A second query resolves the company name + default signature via the
 *     user's account.company_id. Falls back gracefully if the user has no
 *     account or the account isn't linked to a company yet (legacy rows).
 *
 * Both queries use the supplied client — pass the service-role client when
 * calling from a route that already has it; the function never escalates
 * privileges on its own.
 */
export async function resolveSignature(
  supabase: SignatureSupabase,
  userId: string,
  opts: { now?: Date } = {},
): Promise<string | null> {
  if (!userId) return null

  // Cast the chained builder to a thenable that resolves to { data, error }.
  // `from()` is intentionally typed as `unknown` so callers can hand us
  // either the real Supabase client or a lightweight test mock. We re-cast
  // each chain via `as any` at the boundary — narrow internal scope so a
  // typo in column names still surfaces during code review.
  type Row = Record<string, unknown> | null
  type Result = { data: Row; error: unknown }

  // ── 1. Load user row ────────────────────────────────────────────────
  const usersBuilder = supabase.from('users') as unknown as {
    select: (cols: string) => {
      eq: (col: string, val: string) => { maybeSingle: () => Promise<Result> }
    }
  }
  const { data: userRow, error: userErr } = await usersBuilder
    .select('id, email, full_name, email_signature, email_signature_enabled, account_id')
    .eq('id', userId)
    .maybeSingle()

  if (userErr || !userRow) return null

  // ── 2. Load the user's account -> company (only if needed) ─────────
  let companyName: string | null = null
  let companyDefault: string | null = null
  const accountId = userRow.account_id as string | null | undefined
  if (accountId) {
    const accountsBuilder = supabase.from('accounts') as unknown as {
      select: (cols: string) => {
        eq: (col: string, val: string) => { maybeSingle: () => Promise<Result> }
      }
    }
    const { data: account } = await accountsBuilder
      .select('company_id')
      .eq('id', accountId)
      .maybeSingle()
    const companyId = (account?.company_id as string | null | undefined) ?? null
    if (companyId) {
      const companiesBuilder = supabase.from('companies') as unknown as {
        select: (cols: string) => {
          eq: (col: string, val: string) => { maybeSingle: () => Promise<Result> }
        }
      }
      const { data: company } = await companiesBuilder
        .select('name, default_email_signature')
        .eq('id', companyId)
        .maybeSingle()
      if (company) {
        companyName = (company.name as string | null) ?? null
        companyDefault = (company.default_email_signature as string | null) ?? null
      }
    }
  }

  const template = pickSignatureTemplate({
    user_signature: userRow.email_signature as string | null,
    user_signature_enabled: userRow.email_signature_enabled as boolean | null,
    company_default: companyDefault,
  })
  if (template === null) return null

  const now = opts.now ?? new Date()
  return substituteSignatureVariables(template, {
    user: {
      id: userRow.id as string,
      full_name: (userRow.full_name as string | null) ?? null,
      email: (userRow.email as string | null) ?? null,
    },
    company: { name: companyName },
    date: now.toISOString().slice(0, 10),
  })
}

/**
 * Append a resolved signature to an outbound message body using a plain-text
 * "-- " separator (a long-standing convention; survives most quoting). Skips
 * the append when:
 *   - the signature is empty/null
 *   - the body already includes the first 30 chars of the signature
 *     (defensive against double-append when the agent pasted it manually)
 *
 * Returns the original body untouched whenever a no-op is the right call —
 * the caller doesn't need to special-case anything.
 */
export function appendSignatureToBody(body: string, signature: string | null): string {
  if (!signature) return body
  const trimmedSig = signature.trim()
  if (trimmedSig.length === 0) return body
  // Cheap "already there?" check — first 30 chars of the trimmed signature
  // are usually distinctive enough (a name or greeting) to detect a manual
  // paste without doing a full substring scan.
  const probe = trimmedSig.slice(0, 30)
  if (probe.length > 0 && body.includes(probe)) return body
  // Standard plain-text signature delimiter. Two newlines first so we don't
  // smush into the previous paragraph regardless of trailing whitespace.
  return `${body.replace(/\s+$/g, '')}\n\n---\n${trimmedSig}`
}
