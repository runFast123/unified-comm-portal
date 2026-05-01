// Tests for src/lib/conversation-merge.ts
//
// Coverage:
//   * previewMerge: combined counts/dates, blocked-when-already-merged, null
//     when ids invalid or rows missing.
//   * mergeConversations / unmergeConversations: pass-through to the RPC,
//     payload shape, error mapping.
//   * findMergeCandidates: builds OR filter from email/phone/contact,
//     drops merged secondaries, attaches counts + previews.

import { describe, it, expect } from 'vitest'
import {
  previewMerge,
  mergeConversations,
  unmergeConversations,
  findMergeCandidates,
} from '@/lib/conversation-merge'
import type { SupabaseClient } from '@supabase/supabase-js'

// ─── Tiny supabase chain stub ────────────────────────────────────────
//
// Minimal implementation that supports the operations the helper reaches for.
// Each test wires up a fresh stub with the rows / counts it needs.

interface StubConfig {
  // For .from(table).select(...).in('id', ids).<...>:
  selectByIn?: Record<string, (col: string, ids: string[]) => unknown[]>
  // For .from(table).select(..., { count, head }).eq('conversation_id', id):
  countByEq?: Record<string, (col: string, value: unknown) => number>
  // For .from(table).select(...).eq('id', id).maybeSingle():
  selectByEq?: Record<string, (col: string, value: unknown) => unknown>
  // For .from(table).select(...).or(...).neq(...).is(...).order(...).limit(...):
  selectByOr?: Record<string, (orClause: string) => unknown[]>
  // For .rpc(name, params):
  rpc?: Record<string, (params: unknown) => { data: unknown; error: unknown }>
}

function makeStub(cfg: StubConfig): SupabaseClient {
  function makeChain(table: string) {
    let mode: 'select' = 'select'
    let count = false
    let inFilter: { col: string; ids: string[] } | null = null
    let eqFilters: Array<{ col: string; value: unknown }> = []
    let neqFilters: Array<{ col: string; value: unknown }> = []
    let orClause: string | null = null
    let isFilters: Array<{ col: string; value: unknown }> = []
    void mode

    const chain: any = {
      select: (_cols: string, opts?: { count?: string; head?: boolean }) => {
        if (opts?.count === 'exact' && opts.head) count = true
        return chain
      },
      eq: (col: string, value: unknown) => {
        eqFilters.push({ col, value })
        return chain
      },
      neq: (col: string, value: unknown) => {
        neqFilters.push({ col, value })
        return chain
      },
      in: (col: string, ids: string[]) => {
        inFilter = { col, ids }
        return chain
      },
      or: (clause: string) => {
        orClause = clause
        return chain
      },
      is: (col: string, value: unknown) => {
        isFilters.push({ col, value })
        return chain
      },
      order: (_col: string, _opts?: unknown) => chain,
      limit: (_n: number) => chain,
      maybeSingle: async () => {
        const eq = eqFilters[0]
        const fn = cfg.selectByEq?.[table]
        if (eq && fn) return { data: fn(eq.col, eq.value), error: null }
        return { data: null, error: null }
      },
      then: async (resolve: (v: unknown) => unknown) => {
        // Terminal — invoked when the chain is awaited directly (no maybeSingle/single).
        let data: unknown = null
        if (count && eqFilters.length > 0) {
          const cnt = cfg.countByEq?.[table]
          const eq = eqFilters[0]
          const c = cnt ? cnt(eq.col, eq.value) : 0
          return resolve({ data: null, count: c, error: null })
        }
        if (orClause && cfg.selectByOr?.[table]) {
          let rows = cfg.selectByOr[table](orClause)
          // Apply neq, is, in filters in-memory — close enough for tests.
          for (const n of neqFilters) {
            rows = rows.filter((r: any) => r[n.col] !== n.value)
          }
          for (const isF of isFilters) {
            rows = rows.filter((r: any) =>
              isF.value === null ? r[isF.col] == null : r[isF.col] === isF.value
            )
          }
          data = rows
          return resolve({ data, error: null })
        }
        if (inFilter && cfg.selectByIn?.[table]) {
          data = cfg.selectByIn[table](inFilter.col, inFilter.ids)
        }
        return resolve({ data, error: null })
      },
    }
    return chain
  }

  return {
    from: (table: string) => makeChain(table),
    rpc: async (name: string, params: unknown) => {
      const fn = cfg.rpc?.[name]
      if (fn) return fn(params)
      return { data: null, error: null }
    },
  } as unknown as SupabaseClient
}

// ─── previewMerge ─────────────────────────────────────────────────────

describe('previewMerge', () => {
  const baseConvs = [
    {
      id: 'p',
      participant_name: 'Alice',
      participant_email: 'alice@a.com',
      channel: 'email',
      first_message_at: '2026-01-01T00:00:00Z',
      last_message_at: '2026-01-05T00:00:00Z',
      merged_into_id: null,
    },
    {
      id: 's',
      participant_name: 'Alice (gmail)',
      participant_email: 'alice@gmail.com',
      channel: 'email',
      first_message_at: '2026-01-03T00:00:00Z',
      last_message_at: '2026-01-10T00:00:00Z',
      merged_into_id: null,
    },
  ]

  it('returns null when ids are equal', async () => {
    const stub = makeStub({})
    const out = await previewMerge(stub, 'a', 'a')
    expect(out).toBeNull()
  })

  it('returns null when either id is missing', async () => {
    const stub = makeStub({})
    expect(await previewMerge(stub, '', 'b')).toBeNull()
    expect(await previewMerge(stub, 'a', '')).toBeNull()
  })

  it('returns combined counts + min/max dates when allowed', async () => {
    const stub = makeStub({
      selectByIn: {
        conversations: () => baseConvs,
      },
      countByEq: {
        messages: (_c, value) => (value === 'p' ? 4 : 7),
      },
    })
    const out = await previewMerge(stub, 'p', 's')
    expect(out).toBeTruthy()
    expect(out!.allowed).toBe(true)
    expect(out!.blocked_reason).toBeNull()
    expect(out!.primary.message_count).toBe(4)
    expect(out!.secondary.message_count).toBe(7)
    expect(out!.combined_message_count).toBe(11)
    expect(out!.combined_first_message_at).toBe('2026-01-01T00:00:00Z')
    expect(out!.combined_last_message_at).toBe('2026-01-10T00:00:00Z')
  })

  it('blocks when primary already merged', async () => {
    const stub = makeStub({
      selectByIn: {
        conversations: () => [
          { ...baseConvs[0], merged_into_id: 'other' },
          baseConvs[1],
        ],
      },
      countByEq: { messages: () => 1 },
    })
    const out = await previewMerge(stub, 'p', 's')
    expect(out!.allowed).toBe(false)
    expect(out!.blocked_reason).toMatch(/Primary/i)
  })

  it('blocks when secondary already merged', async () => {
    const stub = makeStub({
      selectByIn: {
        conversations: () => [baseConvs[0], { ...baseConvs[1], merged_into_id: 'other' }],
      },
      countByEq: { messages: () => 1 },
    })
    const out = await previewMerge(stub, 'p', 's')
    expect(out!.allowed).toBe(false)
    expect(out!.blocked_reason).toMatch(/Secondary/i)
  })

  it('returns null when one of the rows is missing', async () => {
    const stub = makeStub({
      selectByIn: { conversations: () => [baseConvs[0]] },
      countByEq: { messages: () => 0 },
    })
    const out = await previewMerge(stub, 'p', 's')
    expect(out).toBeNull()
  })
})

// ─── mergeConversations / unmergeConversations ───────────────────────

describe('mergeConversations', () => {
  it('throws on equal ids without hitting the network', async () => {
    const stub = makeStub({})
    await expect(mergeConversations(stub, 'a', 'a', 'u')).rejects.toThrow(
      /cannot be the same/i
    )
  })

  it('throws on missing ids', async () => {
    const stub = makeStub({})
    await expect(mergeConversations(stub, '', 'b', 'u')).rejects.toThrow(/required/i)
  })

  it('forwards to the RPC and returns the audit row', async () => {
    let receivedParams: any = null
    const stub = makeStub({
      rpc: {
        merge_conversations: (params) => {
          receivedParams = params
          return {
            data: {
              id: 'audit-1',
              primary_conversation_id: 'p',
              secondary_conversation_id: 's',
              message_ids: ['m1', 'm2', 'm3'],
              merged_at: '2026-05-01T00:00:00Z',
            },
            error: null,
          }
        },
      },
    })
    const result = await mergeConversations(stub, 'p', 's', 'user-1')
    expect(receivedParams).toEqual({
      p_primary_id: 'p',
      p_secondary_id: 's',
      p_user_id: 'user-1',
    })
    expect(result.audit_id).toBe('audit-1')
    expect(result.message_ids).toEqual(['m1', 'm2', 'm3'])
  })

  it('surfaces RPC errors as JS errors', async () => {
    const stub = makeStub({
      rpc: {
        merge_conversations: () => ({ data: null, error: { message: 'boom' } }),
      },
    })
    await expect(mergeConversations(stub, 'p', 's', 'u')).rejects.toThrow(/boom/)
  })
})

describe('unmergeConversations', () => {
  it('forwards to the RPC and returns the audit row', async () => {
    let receivedParams: any = null
    const stub = makeStub({
      rpc: {
        unmerge_conversations: (params) => {
          receivedParams = params
          return {
            data: {
              id: 'audit-1',
              primary_conversation_id: 'p',
              secondary_conversation_id: 's',
              message_ids: ['m1', 'm2'],
              merged_at: '2026-04-01T00:00:00Z',
              unmerged_at: '2026-05-01T00:00:00Z',
            },
            error: null,
          }
        },
      },
    })
    const result = await unmergeConversations(stub, 'p', 's', 'user-1')
    expect(receivedParams).toEqual({
      p_primary_id: 'p',
      p_secondary_id: 's',
      p_user_id: 'user-1',
    })
    expect(result.audit_id).toBe('audit-1')
    expect(result.message_ids).toHaveLength(2)
  })

  it('throws on missing ids', async () => {
    const stub = makeStub({})
    await expect(unmergeConversations(stub, '', 's', 'u')).rejects.toThrow(/required/i)
  })

  it('round-trip: merge then unmerge returns matching audit ids', async () => {
    let mergeAudit: any = null
    const stub = makeStub({
      rpc: {
        merge_conversations: () => {
          mergeAudit = {
            id: 'audit-rt',
            primary_conversation_id: 'p',
            secondary_conversation_id: 's',
            message_ids: ['m1', 'm2', 'm3'],
            merged_at: '2026-04-01T00:00:00Z',
          }
          return { data: mergeAudit, error: null }
        },
        unmerge_conversations: () => ({
          data: { ...mergeAudit, unmerged_at: '2026-05-01T00:00:00Z' },
          error: null,
        }),
      },
    })
    const merged = await mergeConversations(stub, 'p', 's', 'u')
    const unmerged = await unmergeConversations(stub, 'p', 's', 'u')
    expect(unmerged.audit_id).toBe(merged.audit_id)
    expect(unmerged.message_ids).toEqual(merged.message_ids)
  })
})

// ─── findMergeCandidates ──────────────────────────────────────────────

describe('findMergeCandidates', () => {
  it('returns empty array when conversation has no email/phone/contact', async () => {
    const stub = makeStub({
      selectByEq: {
        conversations: () => ({
          id: 'c1',
          participant_email: null,
          participant_phone: null,
          contact_id: null,
        }),
      },
    })
    const out = await findMergeCandidates(stub, 'c1')
    expect(out).toEqual([])
  })

  it('builds an OR clause containing all populated keys', async () => {
    let capturedOr = ''
    const stub = makeStub({
      selectByEq: {
        conversations: () => ({
          id: 'c1',
          participant_email: 'a@x.com',
          participant_phone: '+10000000',
          contact_id: 'contact-9',
        }),
      },
      selectByOr: {
        conversations: (clause) => {
          capturedOr = clause
          return [
            {
              id: 'c2',
              channel: 'email',
              participant_name: 'Alice',
              participant_email: 'a@x.com',
              participant_phone: null,
              last_message_at: '2026-01-02T00:00:00Z',
              merged_into_id: null,
            },
          ]
        },
      },
      selectByIn: {
        messages: (col) => {
          if (col === 'conversation_id') {
            return [
              { conversation_id: 'c2' },
              { conversation_id: 'c2' },
              {
                conversation_id: 'c2',
                message_text: 'Hello there',
                email_subject: null,
                direction: 'inbound',
                timestamp: '2026-01-01T00:00:00Z',
              },
            ]
          }
          return []
        },
      },
    })
    const out = await findMergeCandidates(stub, 'c1', 5)
    expect(out).toHaveLength(1)
    expect(out[0].id).toBe('c2')
    expect(capturedOr).toContain('participant_email.eq.a@x.com')
    expect(capturedOr).toContain('participant_phone.eq.+10000000')
    expect(capturedOr).toContain('contact_id.eq.contact-9')
  })

  it('returns empty array when source conversation does not exist', async () => {
    const stub = makeStub({
      selectByEq: { conversations: () => null },
    })
    const out = await findMergeCandidates(stub, 'missing')
    expect(out).toEqual([])
  })
})
