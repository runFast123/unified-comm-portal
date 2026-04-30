import { NextResponse } from 'next/server'
import { createServerSupabaseClient, createServiceRoleClient } from '@/lib/supabase-server'

export const runtime = 'nodejs'

const BUCKET = 'attachments'
const EXPIRES_SECONDS = 3600 // 1 hour

/**
 * GET /api/attachments/signed-url?path=<storage path>
 * Returns { url } for a short-lived signed URL. Used by the conversation
 * thread UI when rendering outbound attachment chips (bucket is private).
 *
 * Access control: path is `{owner_user_id}/{conversation_id}/...`. We
 * extract the conversation_id segment and verify the caller has access
 * to that conversation's account (admin or matching account_id).
 */
export async function GET(request: Request) {
  try {
    const supabase = await createServerSupabaseClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const url = new URL(request.url)
    const path = url.searchParams.get('path')
    if (!path) {
      return NextResponse.json({ error: 'Missing path' }, { status: 400 })
    }

    // Parse {user_id}/{conversation_id}/{rest...}
    const segments = path.split('/')
    if (segments.length < 3) {
      return NextResponse.json({ error: 'Invalid path' }, { status: 400 })
    }
    const conversationId = segments[1]

    const admin = await createServiceRoleClient()

    const { data: profile } = await admin
      .from('users')
      .select('role, account_id')
      .eq('id', user.id)
      .maybeSingle()
    if (!profile) return NextResponse.json({ error: 'User profile not found' }, { status: 403 })

    const { data: conv } = await admin
      .from('conversations')
      .select('id, account_id')
      .eq('id', conversationId)
      .maybeSingle()
    if (!conv) return NextResponse.json({ error: 'Conversation not found' }, { status: 404 })

    const isAdmin = profile.role === 'admin'
    if (!isAdmin && profile.account_id !== conv.account_id) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    const { data: signed, error } = await admin.storage
      .from(BUCKET)
      .createSignedUrl(path, EXPIRES_SECONDS)
    if (error || !signed?.signedUrl) {
      return NextResponse.json(
        { error: error?.message || 'Failed to sign URL' },
        { status: 500 }
      )
    }

    return NextResponse.json({ url: signed.signedUrl })
  } catch (err) {
    console.error('Signed-url error:', err)
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Signed URL failed' },
      { status: 500 }
    )
  }
}
