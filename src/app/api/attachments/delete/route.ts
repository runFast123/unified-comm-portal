import { NextResponse } from 'next/server'
import { createServerSupabaseClient, createServiceRoleClient } from '@/lib/supabase-server'

export const runtime = 'nodejs'

const BUCKET = 'attachments'

interface DeleteBody {
  path: string
}

/**
 * POST /api/attachments/delete
 * Removes a previously uploaded attachment from storage.
 * Ownership is enforced by path prefix — the path must start with `{user.id}/`.
 * That prefix is set at upload time and cannot be forged without the service role.
 */
export async function POST(request: Request) {
  try {
    const supabase = await createServerSupabaseClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const body = (await request.json()) as DeleteBody
    if (!body?.path || typeof body.path !== 'string') {
      return NextResponse.json({ error: 'Missing path' }, { status: 400 })
    }

    // Ownership check: path MUST start with `{user.id}/`. Reject anything else.
    const prefix = `${user.id}/`
    if (!body.path.startsWith(prefix)) {
      return NextResponse.json({ error: 'Forbidden: path does not belong to user' }, { status: 403 })
    }

    const admin = await createServiceRoleClient()
    const { error } = await admin.storage.from(BUCKET).remove([body.path])
    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    return NextResponse.json({ success: true })
  } catch (err) {
    console.error('Attachment delete error:', err)
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Delete failed' },
      { status: 500 }
    )
  }
}
