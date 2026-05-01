// Tests for GET /api/conversations/[id]/timeline.
//
// Covers:
//   * 401 when unauthenticated
//   * 404 when the conversation doesn't exist
//   * 403 when caller has no access to the conversation's account
//   * 200 happy path: events from messages, ai_replies, and audit_log are
//     unioned and surfaced — verifying the route correctly maps the rows
//     produced by the conversation_timeline() Postgres function.
//   * Events are returned in chronological order (asc) — the function
//     orders by ts ASC, the route is a passthrough.

import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('next/headers', () => ({
  headers: async () => ({ get: () => null }),
  cookies: async () => ({ getAll: () => [], set: () => {} }),
}))

interface Conv {
  id: string
  account_id: string
}

const fixture = {
  user: { id: 'user-1' } as { id: string } | null,
  conversation: { id: 'conv-1', account_id: 'acct-1' } as Conv | null,
  rpcRows: [] as Array<Record<string, unknown>>,
  rpcError: null as { message: string } | null,
  accessAllowed: true,
  rpcCalls: [] as Array<{ fn: string; args: Record<string, unknown> }>,
}

function makeServerClient() {
  return {
    auth: {
      getUser: async () => ({ data: { user: fixture.user }, error: null }),
    },
  }
}

function makeServiceClient() {
  return {
    from: (_table: string) => {
      const chain: any = {
        select: () => chain,
        eq: () => chain,
        maybeSingle: async () => ({ data: fixture.conversation, error: null }),
      }
      return chain
    },
    rpc: async (fn: string, args: Record<string, unknown>) => {
      fixture.rpcCalls.push({ fn, args })
      if (fixture.rpcError) {
        return { data: null, error: fixture.rpcError }
      }
      return { data: fixture.rpcRows, error: null }
    },
  }
}

vi.mock('@/lib/supabase-server', () => ({
  createServerSupabaseClient: vi.fn(async () => makeServerClient()),
  createServiceRoleClient: vi.fn(async () => makeServiceClient()),
}))

vi.mock('@/lib/api-helpers', () => ({
  verifyAccountAccess: vi.fn(async () => fixture.accessAllowed),
}))

// Import AFTER mocks
import { GET } from '@/app/api/conversations/[id]/timeline/route'

function ctx(id: string) {
  return { params: Promise.resolve({ id }) }
}

beforeEach(() => {
  fixture.user = { id: 'user-1' }
  fixture.conversation = { id: 'conv-1', account_id: 'acct-1' }
  fixture.rpcRows = []
  fixture.rpcError = null
  fixture.accessAllowed = true
  fixture.rpcCalls = []
})

describe('GET /api/conversations/[id]/timeline', () => {
  it('401 when unauthenticated', async () => {
    fixture.user = null
    const res = await GET(new Request('http://localhost'), ctx('conv-1'))
    expect(res.status).toBe(401)
  })

  it('404 when the conversation does not exist', async () => {
    fixture.conversation = null
    const res = await GET(new Request('http://localhost'), ctx('missing'))
    expect(res.status).toBe(404)
  })

  it('403 when caller has no access to the conversation account', async () => {
    fixture.accessAllowed = false
    const res = await GET(new Request('http://localhost'), ctx('conv-1'))
    expect(res.status).toBe(403)
  })

  it('200 happy path: returns the events array', async () => {
    fixture.rpcRows = [
      {
        ts: '2026-04-01T10:00:00Z',
        event_type: 'message_inbound',
        actor_user_id: null,
        actor_label: 'Customer',
        summary: 'Hello',
        details: { channel: 'email', message_id: 'm-1', is_spam: false, sender_type: 'customer' },
      },
    ]
    const res = await GET(new Request('http://localhost'), ctx('conv-1'))
    expect(res.status).toBe(200)
    const json = (await res.json()) as { events: any[] }
    expect(Array.isArray(json.events)).toBe(true)
    expect(json.events).toHaveLength(1)
    expect(json.events[0].event_type).toBe('message_inbound')
    expect(json.events[0].actor_label).toBe('Customer')
    // RPC should have been invoked with the conversation id.
    expect(fixture.rpcCalls).toHaveLength(1)
    expect(fixture.rpcCalls[0]).toEqual({
      fn: 'conversation_timeline',
      args: { p_conversation_id: 'conv-1' },
    })
  })

  it('mixed-source rendering: messages + audit + ai_draft surface in the same array, in order', async () => {
    // The rows are returned by the SQL function ordered ts ASC. Route is a
    // passthrough, so the API output preserves that order.
    fixture.rpcRows = [
      {
        ts: '2026-04-01T10:00:00Z',
        event_type: 'message_inbound',
        actor_user_id: null,
        actor_label: 'Customer',
        summary: 'Question 1',
        details: { channel: 'email', message_id: 'm-1' },
      },
      {
        ts: '2026-04-01T10:05:00Z',
        event_type: 'ai_draft',
        actor_user_id: null,
        actor_label: 'AI',
        summary: 'Drafted reply (status: pending_approval)',
        details: { ai_reply_id: 'ar-1', status: 'pending_approval', confidence: 0.91 },
      },
      {
        ts: '2026-04-01T10:10:00Z',
        event_type: 'conversation.status_changed',
        actor_user_id: 'user-1',
        actor_label: 'Aman',
        summary: 'Status changed from active to in_progress',
        details: { from: 'active', to: 'in_progress' },
      },
      {
        ts: '2026-04-01T10:11:00Z',
        event_type: 'message_outbound',
        actor_user_id: null,
        actor_label: 'Aman',
        summary: 'Thanks for reaching out',
        details: { channel: 'email', message_id: 'm-2' },
      },
    ]
    const res = await GET(new Request('http://localhost'), ctx('conv-1'))
    expect(res.status).toBe(200)
    const json = (await res.json()) as { events: any[] }
    expect(json.events).toHaveLength(4)
    expect(json.events.map((e) => e.event_type)).toEqual([
      'message_inbound',
      'ai_draft',
      'conversation.status_changed',
      'message_outbound',
    ])
    // Sanity: timestamps are non-decreasing.
    const tss = json.events.map((e) => new Date(e.ts).getTime())
    for (let i = 1; i < tss.length; i++) {
      expect(tss[i]).toBeGreaterThanOrEqual(tss[i - 1])
    }
  })

  it('500 when the underlying RPC errors', async () => {
    fixture.rpcError = { message: 'function not found' }
    const res = await GET(new Request('http://localhost'), ctx('conv-1'))
    expect(res.status).toBe(500)
  })

  it('coerces missing details/actor fields to safe defaults', async () => {
    fixture.rpcRows = [
      {
        ts: '2026-04-01T10:00:00Z',
        event_type: 'conversation.snoozed',
        actor_user_id: null,
        actor_label: null,
        summary: null,
        details: null,
      },
    ]
    const res = await GET(new Request('http://localhost'), ctx('conv-1'))
    expect(res.status).toBe(200)
    const json = (await res.json()) as { events: any[] }
    expect(json.events[0].actor_label).toBe('System')
    expect(json.events[0].summary).toBe('')
    expect(json.events[0].details).toBeNull()
  })
})
