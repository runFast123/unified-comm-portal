// Integration test: email ingest with OOO active sends an auto-reply
// once per conversation per OOO window.
//
// We exercise the real /api/webhooks/email route handler with mocked
// Supabase and a sendEmail spy. `after()` is mocked to capture (and
// optionally invoke) the deferred OOO-send callback.

import { describe, it, expect, beforeEach, vi } from 'vitest'

// after() is what the OOO send is fired through. Replace with a synchronous
// version that runs callbacks immediately so the test can assert sendEmail
// was called by the time the route returns.
const afterCallbacks: Array<() => unknown | Promise<unknown>> = []
vi.mock('next/server', async (importActual) => {
  const actual = await importActual<typeof import('next/server')>()
  return {
    ...actual,
    after: vi.fn(async (cb: () => unknown | Promise<unknown>) => {
      afterCallbacks.push(cb)
      // Invoke immediately so sendEmail spy fires within the same tick.
      await cb()
    }),
  }
})

vi.mock('next/headers', () => ({
  headers: async () => ({ get: () => null }),
  cookies: async () => ({ getAll: () => [], set: () => {} }),
}))

vi.mock('@/lib/api-helpers', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/api-helpers')>()
  return {
    ...actual,
    checkRateLimit: vi.fn(async () => true),
  }
})

vi.mock('@/lib/notification-service', () => ({
  triggerNotifications: vi.fn(async () => undefined),
}))

// Spy on sendEmail so we can assert the OOO auto-reply was dispatched.
const sendEmailSpy = vi.fn(
  async (_input: unknown) => ({ ok: true as const, provider_message_id: 'smtp-id-1' })
)
vi.mock('@/lib/channel-sender', () => ({
  sendEmail: (input: unknown) => sendEmailSpy(input),
}))

import type { MockSupabase } from '../helpers/mock-supabase'
import { createMockSupabase } from '../helpers/mock-supabase'

const mockBox: { current: MockSupabase | null } = { current: null }
vi.mock('@/lib/supabase-server', () => ({
  createServiceRoleClient: vi.fn(async () => mockBox.current?.client),
  createServerSupabaseClient: vi.fn(async () => mockBox.current?.client),
}))

import { POST } from '@/app/api/webhooks/email/route'

interface OOOSeed {
  enabled: boolean
  starts_at?: string | null
  ends_at?: string | null
  subject?: string | null
  body?: string | null
}

/**
 * Builds the standard mock used by these tests.
 *
 * Tracks `oooReplies` so the dedup-table behaviour matches what production
 * does: a select returns the row if one was previously inserted, and
 * inserts respect a unique-constraint-style dedup.
 */
function buildMock(opts: { ooo: OOOSeed }) {
  const oooReplies: Array<{ conversation_id: string; ooo_window_start: string }> = []
  const accountRow = {
    id: 'acc-ooo',
    name: 'OOO Account',
    company_id: 'comp-ooo',
    is_active: true,
    spam_detection_enabled: true,
    spam_allowlist: [],
    phase1_enabled: true,
    phase2_enabled: false,
    settings: {},
    ooo_enabled: opts.ooo.enabled,
    ooo_starts_at: opts.ooo.starts_at ?? null,
    ooo_ends_at: opts.ooo.ends_at ?? null,
    ooo_subject: opts.ooo.subject ?? 'Out of office',
    ooo_body: opts.ooo.body ?? 'I am OOO until {{ooo.return_date}}.',
  }
  const companyRow = { id: 'comp-ooo', name: 'OOO Co' }

  return {
    oooReplies,
    mock: createMockSupabase({
      handlers: {
        accounts: {
          onSelect: () => ({ data: accountRow, error: null }),
        },
        companies: {
          onSelect: () => ({ data: companyRow, error: null }),
        },
        conversations: {
          onSelect: () => ({ data: null, error: null }),
          onInsert: () => ({ data: { id: 'conv-ooo-1' }, error: null }),
        },
        messages: {
          onSelect: () => ({ data: null, error: null }),
          onInsert: (payload) => ({
            data: { id: 'msg-ooo-1', ...(payload as Record<string, unknown>) },
            error: null,
          }),
        },
        ooo_replies_sent: {
          onSelect: (filters) => {
            const conv = filters?.find((f) => f.col === 'conversation_id')?.value
            const win = filters?.find((f) => f.col === 'ooo_window_start')?.value
            const found = oooReplies.find(
              (r) => r.conversation_id === conv && r.ooo_window_start === win
            )
            return { data: found ?? null, error: null }
          },
          onInsert: (payload) => {
            const row = payload as { conversation_id: string; ooo_window_start: string }
            const dup = oooReplies.find(
              (r) =>
                r.conversation_id === row.conversation_id &&
                r.ooo_window_start === row.ooo_window_start
            )
            if (dup) return { data: null, error: { code: '23505', message: 'duplicate' } }
            oooReplies.push(row)
            return { data: row, error: null }
          },
        },
      },
    }),
  }
}

function makeRequest(body: Record<string, unknown>): Request {
  return new Request('http://localhost/api/webhooks/email', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-webhook-secret': 'test-secret',
    },
    body: JSON.stringify(body),
  })
}

beforeEach(() => {
  process.env.WEBHOOK_SECRET = 'test-secret'
  sendEmailSpy.mockClear()
  afterCallbacks.length = 0
})

describe('OOO ingest hook (email)', () => {
  it('OOO inactive: no auto-reply, no dedup row written', async () => {
    const built = buildMock({ ooo: { enabled: false } })
    mockBox.current = built.mock
    const res = await POST(
      makeRequest({
        sender: 'Customer <user@example.com>',
        subject: 'help',
        body: 'I need help with my account please',
        account_id: 'acc-ooo',
      })
    )
    expect(res.status).toBe(201)
    expect(sendEmailSpy).not.toHaveBeenCalled()
    expect(built.oooReplies.length).toBe(0)
  })

  it('OOO active: sends one auto-reply on first inbound', async () => {
    const built = buildMock({
      ooo: {
        enabled: true,
        starts_at: '2026-04-01T00:00:00Z',
        ends_at: '2099-01-01T00:00:00Z',
        subject: 'Away',
        body: 'Hi {{customer.name}}, back on {{ooo.return_date}}. — {{company.name}}',
      },
    })
    mockBox.current = built.mock
    const res = await POST(
      makeRequest({
        sender: 'Bob <bob@example.com>',
        subject: 'help',
        body: 'I need help with my account please',
        account_id: 'acc-ooo',
      })
    )
    expect(res.status).toBe(201)
    expect(sendEmailSpy).toHaveBeenCalledTimes(1)
    const call = (sendEmailSpy.mock.calls as unknown as Array<[unknown]>)[0][0] as {
      to: string
      subject: string
      body: string
      accountId: string
    }
    expect(call.to).toBe('bob@example.com')
    expect(call.accountId).toBe('acc-ooo')
    expect(call.subject).toBe('Away')
    expect(call.body).toContain('Hi Bob')
    expect(call.body).toContain('OOO Co') // {{company.name}}
    // Dedup row written so a follow-up doesn't re-fire.
    expect(built.oooReplies.length).toBe(1)
    expect(built.oooReplies[0].conversation_id).toBe('conv-ooo-1')
  })

  it('OOO active: second inbound on the same conversation does NOT auto-reply', async () => {
    const built = buildMock({
      ooo: {
        enabled: true,
        starts_at: '2026-04-01T00:00:00Z',
        ends_at: '2099-01-01T00:00:00Z',
      },
    })
    // Pre-seed the dedup row for this conv+window — simulates "already replied".
    built.oooReplies.push({
      conversation_id: 'conv-ooo-1',
      ooo_window_start: '2026-04-01T00:00:00.000Z',
    })
    mockBox.current = built.mock
    const res = await POST(
      makeRequest({
        sender: 'Bob <bob@example.com>',
        subject: 'follow up',
        body: 'just following up on my earlier email',
        account_id: 'acc-ooo',
      })
    )
    expect(res.status).toBe(201)
    expect(sendEmailSpy).not.toHaveBeenCalled()
    // Still exactly one dedup row — no new insert.
    expect(built.oooReplies.length).toBe(1)
  })

  it('OOO active but message is spam: no auto-reply', async () => {
    const built = buildMock({
      ooo: {
        enabled: true,
        starts_at: '2026-04-01T00:00:00Z',
        ends_at: '2099-01-01T00:00:00Z',
      },
    })
    mockBox.current = built.mock
    const res = await POST(
      makeRequest({
        sender: 'noreply@bank.com',
        subject: 'Statement',
        body: 'Your statement is attached.',
        account_id: 'acc-ooo',
      })
    )
    expect(res.status).toBe(201)
    expect(sendEmailSpy).not.toHaveBeenCalled()
    expect(built.oooReplies.length).toBe(0)
  })

  it('OOO enabled but window has expired: no auto-reply', async () => {
    const built = buildMock({
      ooo: {
        enabled: true,
        starts_at: '2026-01-01T00:00:00Z',
        ends_at: '2026-01-15T00:00:00Z', // safely in the past
      },
    })
    mockBox.current = built.mock
    const res = await POST(
      makeRequest({
        sender: 'Bob <bob@example.com>',
        subject: 'help',
        body: 'still need help with my account please',
        account_id: 'acc-ooo',
      })
    )
    expect(res.status).toBe(201)
    expect(sendEmailSpy).not.toHaveBeenCalled()
  })
})
