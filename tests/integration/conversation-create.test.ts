// Integration test: findOrCreateConversation
//
// Drives the real helper against the mock-supabase factory. Complements the
// existing tests/lib/find-or-create-conversation.test.ts by routing every
// path through the shared `createMockSupabase` so changes to that helper are
// caught here too.

import { describe, it, expect, vi } from 'vitest'

// `api-helpers.ts` imports supabase-server + rate-limiter at module top.
// Stub both so importing the file is safe in pure-Node.
vi.mock('@/lib/supabase-server', () => ({ createServiceRoleClient: vi.fn() }))
vi.mock('@/lib/rate-limiter', () => ({ checkRateLimit: vi.fn() }))

import { findOrCreateConversation } from '@/lib/api-helpers'
import { createMockSupabase } from '../helpers/mock-supabase'

type SupabaseLike = Parameters<typeof findOrCreateConversation>[0]
const asSupabase = (client: unknown): SupabaseLike => client as SupabaseLike

describe('findOrCreateConversation — integration with mock-supabase helper', () => {
  it('returns existing id and does NOT insert when an active conversation is found', async () => {
    const mock = createMockSupabase({
      handlers: {
        conversations: {
          onSelect: () => ({ data: { id: 'conv-active', status: 'active' }, error: null }),
        },
      },
    })

    const id = await findOrCreateConversation(
      asSupabase(mock.client),
      {
        account_id: 'acc-1',
        channel: 'email',
        participant_email: 'u@x.com',
      },
    )

    expect(id).toBe('conv-active')
    expect(mock.insertsFor('conversations')).toHaveLength(0)
    // Update was issued for last_message_at, but status should not be set
    // when the existing row was already active.
    const updates = mock.updatesFor('conversations')
    expect(updates).toHaveLength(1)
    expect((updates[0] as Record<string, unknown>).status).toBeUndefined()
    expect((updates[0] as Record<string, unknown>).last_message_at).toBeDefined()
  })

  it('reactivates a resolved conversation: status flips to active, last_message_at updated', async () => {
    const mock = createMockSupabase({
      handlers: {
        conversations: {
          onSelect: () => ({ data: { id: 'conv-resolved', status: 'resolved' }, error: null }),
        },
      },
    })

    const id = await findOrCreateConversation(
      asSupabase(mock.client),
      {
        account_id: 'acc-1',
        channel: 'email',
        participant_email: 'u@x.com',
      },
    )

    expect(id).toBe('conv-resolved')
    const updates = mock.updatesFor('conversations')
    expect(updates).toHaveLength(1)
    expect((updates[0] as Record<string, unknown>).status).toBe('active')
    expect((updates[0] as Record<string, unknown>).last_message_at).toBeDefined()
  })

  it('no existing → insert path returns new id', async () => {
    const mock = createMockSupabase({
      handlers: {
        conversations: {
          onSelect: () => ({ data: null, error: null }),
          onInsert: () => ({ data: { id: 'conv-fresh' }, error: null }),
        },
      },
    })

    const id = await findOrCreateConversation(
      asSupabase(mock.client),
      {
        account_id: 'acc-1',
        channel: 'email',
        participant_email: 'new@example.com',
      },
    )

    expect(id).toBe('conv-fresh')
    expect(mock.insertsFor('conversations')).toHaveLength(1)
  })

  it('race: insert returns 23505 unique-violation on Teams → re-lookup returns winner id', async () => {
    // First select: no existing. Insert: 23505. Second select (re-lookup): the winner.
    let selectCalls = 0
    const mock = createMockSupabase({
      handlers: {
        conversations: {
          onSelect: () => {
            selectCalls += 1
            if (selectCalls === 1) return { data: null, error: null }
            return { data: { id: 'conv-winner' }, error: null }
          },
          onInsert: () => ({
            data: null,
            error: { code: '23505', message: 'duplicate key value violates unique constraint' },
          }),
        },
      },
    })

    const id = await findOrCreateConversation(
      asSupabase(mock.client),
      {
        account_id: 'acc-1',
        channel: 'teams',
        teams_chat_id: 'chat-race',
      },
    )

    expect(id).toBe('conv-winner')
  })

  it('insert fails with non-unique error → throws descriptive Error', async () => {
    const mock = createMockSupabase({
      handlers: {
        conversations: {
          onSelect: () => ({ data: null, error: null }),
          onInsert: () => ({
            data: null,
            error: { code: '500', message: 'database is on fire' },
          }),
        },
      },
    })

    await expect(
      findOrCreateConversation(
        asSupabase(mock.client),
        {
          account_id: 'acc-1',
          channel: 'teams',
          teams_chat_id: 'chat-x',
        },
      ),
    ).rejects.toThrow(/Failed to create conversation/)
  })
})
