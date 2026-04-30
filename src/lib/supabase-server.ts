import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'

// Enforce that the app only ever talks to the expected Supabase project.
// Protects against an accidental .env pointing at a different (e.g. prod) project.
function assertExpectedProject(url: string | undefined) {
  const expected = process.env.SUPABASE_EXPECTED_PROJECT_REF
  if (!expected) return
  if (!url) {
    throw new Error('NEXT_PUBLIC_SUPABASE_URL is not set')
  }
  const match = url.match(/^https?:\/\/([a-z0-9]+)\.supabase\.co/i)
  const ref = match?.[1]
  if (ref !== expected) {
    throw new Error(
      `Supabase project ref mismatch. Expected "${expected}" but NEXT_PUBLIC_SUPABASE_URL points at "${ref ?? url}". ` +
      'This build is locked to a single project for safety.'
    )
  }
}

export async function createServerSupabaseClient() {
  assertExpectedProject(process.env.NEXT_PUBLIC_SUPABASE_URL)
  const cookieStore = await cookies()

  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll()
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options)
            )
          } catch {
            // Server component - ignore
          }
        },
      },
    }
  )
}

export async function createServiceRoleClient() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  assertExpectedProject(supabaseUrl)

  if (!supabaseUrl) {
    throw new Error(
      'Missing NEXT_PUBLIC_SUPABASE_URL environment variable. Ensure it is set in your .env file.'
    )
  }
  if (!serviceRoleKey) {
    throw new Error(
      'Missing SUPABASE_SERVICE_ROLE_KEY environment variable. Ensure it is set in your .env file. ' +
      'This key is required for server-side admin operations.'
    )
  }

  const { createClient } = await import('@supabase/supabase-js')
  return createClient(supabaseUrl, serviceRoleKey)
}
