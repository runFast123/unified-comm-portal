import { NextResponse } from 'next/server'
import { createServerSupabaseClient, createServiceRoleClient } from '@/lib/supabase-server'
import { getGoogleOAuth, getAzureOAuth } from '@/lib/integration-settings'

export const dynamic = 'force-dynamic'

async function requireAdmin() {
  const supabase = await createServerSupabaseClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return { ok: false as const, status: 401, error: 'Unauthorized' }
  const admin = await createServiceRoleClient()
  const { data: profile } = await admin
    .from('users')
    .select('role')
    .eq('id', user.id)
    .maybeSingle()
  if (!['admin','super_admin','company_admin'].includes(profile?.role ?? '')) return { ok: false as const, status: 403, error: 'Admin only' }
  return { ok: true as const }
}

/**
 * GET /api/auth/availability
 *
 * Reports which OAuth providers the create-flow can offer out-of-the-box.
 *
 *   gmail — true when Google OAuth creds are configured, either in
 *           integration_settings (admin UI) or via GOOGLE_OAUTH_CLIENT_ID +
 *           GOOGLE_OAUTH_CLIENT_SECRET env vars. One Google Cloud app
 *           covers every end user.
 *
 *   teams — true when Azure OAuth creds are configured in integration_settings
 *           or via AZURE_TENANT_ID + AZURE_CLIENT_ID + AZURE_CLIENT_SECRET
 *           env vars (shared Azure app registration). Without those, Teams
 *           OAuth is unavailable during create because each account's Azure
 *           creds are stored per-account and the callback needs them to
 *           exchange the auth code.
 */
export async function GET() {
  const gate = await requireAdmin()
  if (!gate.ok) return NextResponse.json({ error: gate.error }, { status: gate.status })

  // DB-first, env fallback — same resolution as every other caller of the
  // integration-settings helpers.
  const [google, azure] = await Promise.all([getGoogleOAuth(), getAzureOAuth()])

  return NextResponse.json({
    gmail: Boolean(google),
    teams: Boolean(azure),
  })
}
