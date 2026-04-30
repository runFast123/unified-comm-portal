import { NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase-server'

/**
 * GET /api/test-connection
 * Tests connectivity to Supabase.
 * Returns status of each service.
 */
export async function GET() {
  // Require authenticated user session
  try {
    const supabase = await createServerSupabaseClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }
  } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const results: {
    supabase: { status: string; details: string; connected: boolean }
    env_vars: Record<string, boolean>
  } = {
    supabase: { status: 'unchecked', details: '', connected: false },
    env_vars: {
      NEXT_PUBLIC_SUPABASE_URL: !!process.env.NEXT_PUBLIC_SUPABASE_URL,
      NEXT_PUBLIC_SUPABASE_ANON_KEY: !!process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
      SUPABASE_SERVICE_ROLE_KEY: !!process.env.SUPABASE_SERVICE_ROLE_KEY,
      AI_API_KEY: !!process.env.AI_API_KEY,
    },
  }

  // ========== TEST SUPABASE ==========
  try {
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
    const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY

    if (!supabaseUrl || !supabaseKey) {
      results.supabase = {
        status: 'error',
        details: 'Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY / NEXT_PUBLIC_SUPABASE_ANON_KEY',
        connected: false,
      }
    } else {
      // Test by directly querying the accounts table (works with both anon and service role keys)
      const schemaResponse = await fetch(`${supabaseUrl}/rest/v1/accounts?select=id,name,channel_type&limit=5`, {
        method: 'GET',
        headers: {
          apikey: supabaseKey,
          Authorization: `Bearer ${supabaseKey}`,
        },
      })

      if (schemaResponse.ok) {
        const data = await schemaResponse.json()
        // Also get total count
        const countResponse = await fetch(`${supabaseUrl}/rest/v1/accounts?select=id`, {
          method: 'HEAD',
          headers: {
            apikey: supabaseKey,
            Authorization: `Bearer ${supabaseKey}`,
            Prefer: 'count=exact',
          },
        })
        const totalCount = countResponse.headers.get('content-range')?.split('/')?.[1] || String(Array.isArray(data) ? data.length : 0)
        results.supabase = {
          status: 'connected',
          details: `Connected to Supabase. Accounts table exists with ${totalCount} accounts. Service role key: ${process.env.SUPABASE_SERVICE_ROLE_KEY ? 'configured' : 'not set (optional for basic use)'}.`,
          connected: true,
        }
      } else if (schemaResponse.status === 404 || schemaResponse.status === 400) {
        // Try a basic health check instead
        const healthResponse = await fetch(`${supabaseUrl}/rest/v1/`, {
          method: 'GET',
          headers: {
            apikey: supabaseKey,
            Authorization: `Bearer ${supabaseKey}`,
          },
        })
        if (healthResponse.ok || healthResponse.status === 200) {
          results.supabase = {
            status: 'partial',
            details: 'Connected to Supabase but the "accounts" table does not exist yet. Run the schema.sql migration.',
            connected: true,
          }
        } else {
          results.supabase = {
            status: 'partial',
            details: 'Connected to Supabase but the "accounts" table may not exist. Run the schema.sql migration.',
            connected: true,
          }
        }
      } else {
        const errorText = await schemaResponse.text()
        results.supabase = {
          status: 'error',
          details: `Supabase connection failed (${schemaResponse.status}): ${errorText.substring(0, 200)}`,
          connected: false,
        }
      }
    }
  } catch (error) {
    results.supabase = {
      status: 'error',
      details: `Supabase connection error: ${error instanceof Error ? error.message : String(error)}`,
      connected: false,
    }
  }

  const allConnected = results.supabase.connected
  return NextResponse.json(
    {
      overall: allConnected ? 'all_connected' : 'issues_found',
      timestamp: new Date().toISOString(),
      ...results,
    },
    { status: 200 }
  )
}
