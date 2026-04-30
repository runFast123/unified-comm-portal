/**
 * Signature management endpoints.
 *
 *   GET  /api/users/signature          -> current viewer's effective signature +
 *                                          raw user/company values + a rendered
 *                                          preview using the current viewer's
 *                                          variable context.
 *   POST /api/users/signature          -> update the current viewer's per-user
 *                                          signature + enabled flag.
 *   PUT  /api/companies/[id]/signature -> live in the companies route file
 *                                          (admin-only). See sibling file.
 *
 * No service-role required for the user route — the user is updating their
 * own row and RLS ought to allow that. We still go through the server
 * supabase client so cookies (and `auth.uid()`) flow through.
 */

import { NextResponse } from 'next/server'
import { createServerSupabaseClient, createServiceRoleClient } from '@/lib/supabase-server'
import { resolveSignature } from '@/lib/email-signature'

interface UpdateSignatureBody {
  email_signature?: string | null
  email_signature_enabled?: boolean
}

export async function GET() {
  const supabase = await createServerSupabaseClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  // Use service-role for the join because the user might not have a direct
  // RLS read on companies in some configurations.
  const admin = await createServiceRoleClient()
  const { data: profile } = await admin
    .from('users')
    .select('id, email, full_name, email_signature, email_signature_enabled, account_id')
    .eq('id', user.id)
    .maybeSingle()

  let companyName: string | null = null
  let companyDefault: string | null = null
  if (profile?.account_id) {
    const { data: account } = await admin
      .from('accounts')
      .select('company_id')
      .eq('id', profile.account_id)
      .maybeSingle()
    if (account?.company_id) {
      const { data: company } = await admin
        .from('companies')
        .select('name, default_email_signature')
        .eq('id', account.company_id)
        .maybeSingle()
      companyName = (company?.name as string | null) ?? null
      companyDefault = (company?.default_email_signature as string | null) ?? null
    }
  }

  const resolved = await resolveSignature(admin, user.id)

  return NextResponse.json({
    user: {
      email_signature: profile?.email_signature ?? null,
      email_signature_enabled: profile?.email_signature_enabled ?? true,
      full_name: profile?.full_name ?? null,
      email: profile?.email ?? user.email ?? null,
    },
    company: {
      name: companyName,
      default_email_signature: companyDefault,
    },
    resolved,
    /** Preview helper — frontend can also re-run substitution on the live
     *  textarea contents using the same context. */
    substitute_context: {
      'user.full_name': profile?.full_name ?? '',
      'user.email': profile?.email ?? user.email ?? '',
      'company.name': companyName ?? '',
      date: new Date().toISOString().slice(0, 10),
    },
  })
}

export async function POST(request: Request) {
  const supabase = await createServerSupabaseClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  let body: UpdateSignatureBody
  try {
    body = (await request.json()) as UpdateSignatureBody
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const patch: Record<string, unknown> = {}
  if (body.email_signature !== undefined) {
    if (body.email_signature !== null && typeof body.email_signature !== 'string') {
      return NextResponse.json({ error: 'email_signature must be a string or null' }, { status: 400 })
    }
    // Cap at 8KB — way more than any real signature, but stops accidental
    // pastes of an entire email thread from getting saved.
    if (body.email_signature && body.email_signature.length > 8192) {
      return NextResponse.json({ error: 'email_signature exceeds 8KB' }, { status: 400 })
    }
    patch.email_signature = body.email_signature
  }
  if (body.email_signature_enabled !== undefined) {
    if (typeof body.email_signature_enabled !== 'boolean') {
      return NextResponse.json({ error: 'email_signature_enabled must be a boolean' }, { status: 400 })
    }
    patch.email_signature_enabled = body.email_signature_enabled
  }
  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: 'No fields to update' }, { status: 400 })
  }

  const admin = await createServiceRoleClient()
  const { error } = await admin.from('users').update(patch).eq('id', user.id)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  // Audit so admins can see who toggled signatures off.
  try {
    await admin.from('audit_log').insert({
      user_id: user.id,
      action: 'user.signature.update',
      entity_type: 'user',
      entity_id: user.id,
      details: { changed: Object.keys(patch) },
    })
  } catch { /* non-fatal */ }

  return NextResponse.json({ success: true })
}
