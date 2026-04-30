// Integration test: POST /api/webhooks/email
//
// We exercise the real route handler with mocked Supabase, mocked rate-limit,
// mocked notification fan-out, and a spy on `after()` from `next/server`.
// Spam detection + findOrCreateConversation are NOT mocked — they run for real
// against the mock Supabase so the contract between webhook → spam → conv →
// message → AI dispatch is locked in.

import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'

// `after()` from next/server fires the AI dispatches. Spy on it so tests can
// assert "AI was/wasn't called". `importActual` keeps NextResponse intact.
vi.mock('next/server', async (importActual) => {
  const actual = await importActual<typeof import('next/server')>()
  return { ...actual, after: vi.fn() }
})

// next/headers — getRequestId() calls headers(), which throws outside a request.
// Stub so it returns null, causing a UUID to be minted.
vi.mock('next/headers', () => ({
  headers: async () => ({ get: () => null }),
  cookies: async () => ({ getAll: () => [], set: () => {} }),
}))

// Rate limiter — toggle via `rateLimitAllowed` so individual tests can flip it.
const { rateLimitAllowed } = vi.hoisted(() => ({ rateLimitAllowed: { v: true } }))
vi.mock('@/lib/api-helpers', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/api-helpers')>()
  return {
    ...actual,
    checkRateLimit: vi.fn(async () => rateLimitAllowed.v),
  }
})

// Notification service — stub the trigger so the route doesn't try to send
// real notifications. `import('@/lib/notification-service')` happens dynamically.
vi.mock('@/lib/notification-service', () => ({
  triggerNotifications: vi.fn(async () => undefined),
}))

// Supabase service-role client — the route only awaits `createServiceRoleClient()`
// once, so we hand back the same mock per test.
import type { MockSupabase } from '../helpers/mock-supabase'
import { createMockSupabase } from '../helpers/mock-supabase'

const mockBox: { current: MockSupabase | null } = { current: null }
vi.mock('@/lib/supabase-server', () => ({
  createServiceRoleClient: vi.fn(async () => mockBox.current?.client),
  createServerSupabaseClient: vi.fn(async () => mockBox.current?.client),
}))

// Import AFTER mocks. Pull `after` for assertions, POST is the route.
import { after } from 'next/server'
import { POST } from '@/app/api/webhooks/email/route'

const ORIGINAL_SECRET = process.env.WEBHOOK_SECRET

function makeRequest(body: Record<string, unknown>, opts?: { secret?: string | null }): Request {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  const secret = opts?.secret === undefined ? 'test-secret' : opts.secret
  if (secret !== null) headers['x-webhook-secret'] = secret
  return new Request('http://localhost/api/webhooks/email', {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  })
}

interface AccountSeed {
  id: string
  name?: string
  is_active?: boolean
  spam_detection_enabled?: boolean | null
  spam_allowlist?: string[] | null
  phase1_enabled?: boolean
  phase2_enabled?: boolean
}

/** Build the standard mock used by most tests. Each table is wired via handlers
 *  so we can branch on filters (account select vs message dedup select). */
function buildMock(account: AccountSeed | null) {
  const accountRow = account
    ? {
        id: account.id,
        name: account.name ?? 'Test Account',
        is_active: account.is_active ?? true,
        spam_detection_enabled: account.spam_detection_enabled ?? true,
        spam_allowlist: account.spam_allowlist ?? [],
        phase1_enabled: account.phase1_enabled ?? true,
        phase2_enabled: account.phase2_enabled ?? true,
        // settings used by getAccountSettings (.select('*'))
        settings: {},
      }
    : null

  return createMockSupabase({
    handlers: {
      accounts: {
        // Same row returned both for the `.select('id, name, ...')` row check
        // and for `getAccountSettings` (.select('*')).
        onSelect: () => ({ data: accountRow, error: accountRow ? null : { message: 'not found' } }),
      },
      conversations: {
        // No existing conversation → falls through to insert path.
        onSelect: () => ({ data: null, error: null }),
        onInsert: () => ({ data: { id: 'conv-new-1' }, error: null }),
      },
      messages: {
        // Default: no dedup hit. Tests that need a hit override this handler.
        onSelect: () => ({ data: null, error: null }),
        onInsert: (payload) => ({
          data: { id: 'msg-new-1', ...(payload as Record<string, unknown>) },
          error: null,
        }),
      },
    },
  })
}

beforeEach(() => {
  vi.mocked(after).mockClear()
  rateLimitAllowed.v = true
  process.env.WEBHOOK_SECRET = 'test-secret'
})

describe('POST /api/webhooks/email — integration', () => {
  it('happy path: 201, inserts message + conversation, dispatches AI via after()', async () => {
    mockBox.current = buildMock({ id: 'acc-1' })
    const res = await POST(
      makeRequest({
        sender: 'Customer Name <user@example.com>',
        subject: 'Help please',
        body: 'I need assistance with my order.',
        account_id: 'acc-1',
      }),
    )

    expect(res.status).toBe(201)
    const json = (await res.json()) as Record<string, unknown>
    expect(json.message_id).toBe('msg-new-1')
    expect(json.is_spam).toBe(false)

    const { calls, insertsFor } = mockBox.current!
    // Conversation lookup happened, then insert.
    const convOps = calls.filter((c) => c.table === 'conversations')
    expect(convOps.some((c) => c.op === 'select')).toBe(true)
    expect(convOps.some((c) => c.op === 'insert')).toBe(true)
    // Message insert payload attached to the new conversation id.
    const msgInserts = insertsFor('messages')
    expect(msgInserts).toHaveLength(1)
    const msg = msgInserts[0] as Record<string, unknown>
    expect(msg.conversation_id).toBe('conv-new-1')
    expect(msg.account_id).toBe('acc-1')
    expect(msg.sender_name).toBe('Customer Name')
    expect(msg.is_spam).toBe(false)
    expect(msg.reply_required).toBe(true)

    // Phase1 + Phase2 enabled → after() called twice.
    expect(vi.mocked(after)).toHaveBeenCalledTimes(2)
  })

  it('missing X-Webhook-Secret → 401', async () => {
    mockBox.current = buildMock({ id: 'acc-1' })
    const res = await POST(
      makeRequest(
        { sender: 'a@b.com', subject: 's', body: 'b', account_id: 'acc-1' },
        { secret: null },
      ),
    )
    expect(res.status).toBe(401)
    expect(vi.mocked(after)).not.toHaveBeenCalled()
  })

  it('account_id refers to a missing account → 404', async () => {
    mockBox.current = buildMock(null)
    const res = await POST(
      makeRequest({
        sender: 'a@b.com',
        subject: 's',
        body: 'b',
        account_id: 'acc-missing',
      }),
    )
    expect(res.status).toBe(404)
  })

  it('account exists but is_active=false → 403', async () => {
    mockBox.current = buildMock({ id: 'acc-1', is_active: false })
    const res = await POST(
      makeRequest({
        sender: 'a@b.com',
        subject: 's',
        body: 'b',
        account_id: 'acc-1',
      }),
    )
    expect(res.status).toBe(403)
  })

  it('spam: noreply@bank.com → message stored is_spam:true, reply_required:false, no AI dispatch', async () => {
    mockBox.current = buildMock({ id: 'acc-1' })
    const res = await POST(
      makeRequest({
        sender: 'noreply@bank.com',
        subject: 'Your statement',
        body: 'Statement attached',
        account_id: 'acc-1',
      }),
    )
    expect(res.status).toBe(201)
    const json = (await res.json()) as Record<string, unknown>
    expect(json.is_spam).toBe(true)

    const msg = mockBox.current!.insertsFor('messages')[0] as Record<string, unknown>
    expect(msg.is_spam).toBe(true)
    expect(msg.reply_required).toBe(false)
    // Spam path skips AI fan-out.
    expect(vi.mocked(after)).not.toHaveBeenCalled()
  })

  it('spam allowlist override: account allowlists "bank.com" → noreply@bank.com is NOT spam, AI dispatched', async () => {
    mockBox.current = buildMock({
      id: 'acc-1',
      spam_allowlist: ['bank.com'],
    })
    const res = await POST(
      makeRequest({
        sender: 'noreply@bank.com',
        subject: 'Your statement',
        body: 'Statement attached',
        account_id: 'acc-1',
      }),
    )
    expect(res.status).toBe(201)
    const json = (await res.json()) as Record<string, unknown>
    expect(json.is_spam).toBe(false)

    const msg = mockBox.current!.insertsFor('messages')[0] as Record<string, unknown>
    expect(msg.is_spam).toBe(false)
    expect(msg.reply_required).toBe(true)
    // Both phases enabled → 2 dispatches.
    expect(vi.mocked(after)).toHaveBeenCalledTimes(2)
  })

  it('dedup: second identical body within 5 min returns 200 with Duplicate', async () => {
    // Override messages.onSelect to return a hit (simulating an existing recent row).
    const mock = createMockSupabase({
      handlers: {
        accounts: {
          onSelect: () => ({
            data: {
              id: 'acc-1',
              name: 'Test',
              is_active: true,
              spam_detection_enabled: true,
              spam_allowlist: [],
              phase1_enabled: true,
              phase2_enabled: true,
              settings: {},
            },
            error: null,
          }),
        },
        messages: {
          // First select on `messages` is the dedup check — return a hit.
          onSelect: () => ({ data: { id: 'msg-existing' }, error: null }),
        },
      },
    })
    mockBox.current = mock
    const res = await POST(
      makeRequest({
        sender: 'user@example.com',
        subject: 'Same subject',
        body: 'This is the duplicate message body that matches the first 100 chars window for the dedup check exactly.',
        account_id: 'acc-1',
      }),
    )
    expect(res.status).toBe(200)
    const json = (await res.json()) as Record<string, unknown>
    expect(json.message).toMatch(/Duplicate/i)
    // No AI dispatch on dedup short-circuit.
    expect(vi.mocked(after)).not.toHaveBeenCalled()
  })

  it('rate limit exceeded → 429', async () => {
    mockBox.current = buildMock({ id: 'acc-1' })
    rateLimitAllowed.v = false
    const res = await POST(
      makeRequest({
        sender: 'a@b.com',
        subject: 's',
        body: 'b',
        account_id: 'acc-1',
      }),
    )
    expect(res.status).toBe(429)
  })
})

// Restore env after the suite so we don't leak the test secret.
afterAll(() => {
  if (ORIGINAL_SECRET === undefined) delete process.env.WEBHOOK_SECRET
  else process.env.WEBHOOK_SECRET = ORIGINAL_SECRET
})
