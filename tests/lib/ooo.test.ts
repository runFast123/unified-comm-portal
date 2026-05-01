// Tests for src/lib/ooo.ts
//
// Pure-TS coverage for:
//   - isAccountOOO window math (open / closed bounds, disabled toggle)
//   - shouldSendOOOReply / recordOOOReply dedup against a mock supabase
//   - substituteOOOVariables variable expansion + sanitisation

import { describe, it, expect } from 'vitest'
import {
  isAccountOOO,
  shouldSendOOOReply,
  recordOOOReply,
  substituteOOOVariables,
  OOO_VARIABLES,
} from '@/lib/ooo'
import type { SupabaseClient } from '@supabase/supabase-js'

// ─── isAccountOOO ────────────────────────────────────────────────────

describe('isAccountOOO', () => {
  const NOW = new Date('2026-05-01T12:00:00Z')

  it('returns false when ooo_enabled is missing or false', () => {
    expect(isAccountOOO({}, NOW)).toBe(false)
    expect(isAccountOOO({ ooo_enabled: false }, NOW)).toBe(false)
    expect(isAccountOOO({ ooo_enabled: null }, NOW)).toBe(false)
  })

  it('returns true when enabled and both bounds null (always-on)', () => {
    expect(isAccountOOO({ ooo_enabled: true }, NOW)).toBe(true)
    expect(
      isAccountOOO(
        { ooo_enabled: true, ooo_starts_at: null, ooo_ends_at: null },
        NOW
      )
    ).toBe(true)
  })

  it('returns false before the start time', () => {
    expect(
      isAccountOOO(
        { ooo_enabled: true, ooo_starts_at: '2026-05-02T00:00:00Z' },
        NOW
      )
    ).toBe(false)
  })

  it('returns false after the end time', () => {
    expect(
      isAccountOOO(
        { ooo_enabled: true, ooo_ends_at: '2026-04-30T00:00:00Z' },
        NOW
      )
    ).toBe(false)
  })

  it('returns true inside a closed window', () => {
    expect(
      isAccountOOO(
        {
          ooo_enabled: true,
          ooo_starts_at: '2026-04-30T00:00:00Z',
          ooo_ends_at: '2026-05-02T00:00:00Z',
        },
        NOW
      )
    ).toBe(true)
  })

  it('handles open-ended start (no start, end in future)', () => {
    expect(
      isAccountOOO(
        { ooo_enabled: true, ooo_ends_at: '2026-05-02T00:00:00Z' },
        NOW
      )
    ).toBe(true)
  })

  it('handles open-ended end (start in past, no end)', () => {
    expect(
      isAccountOOO(
        { ooo_enabled: true, ooo_starts_at: '2026-04-01T00:00:00Z' },
        NOW
      )
    ).toBe(true)
  })

  it('treats unparseable dates as if not set (open-ended)', () => {
    expect(
      isAccountOOO(
        { ooo_enabled: true, ooo_starts_at: 'not-a-date', ooo_ends_at: 'also-not' },
        NOW
      )
    ).toBe(true)
  })

  it('boundaries are inclusive', () => {
    const exactly = new Date('2026-05-01T12:00:00Z')
    expect(
      isAccountOOO(
        {
          ooo_enabled: true,
          ooo_starts_at: '2026-05-01T12:00:00Z',
          ooo_ends_at: '2026-05-01T12:00:00Z',
        },
        exactly
      )
    ).toBe(true)
  })
})

// ─── shouldSendOOOReply / recordOOOReply ──────────────────────────────

interface Insert {
  account_id: string
  conversation_id: string
  ooo_window_start: string
}

function makeStub(initial: Insert[] = []) {
  const inserts: Insert[] = [...initial]
  let nextSelectError: { message: string } | null = null
  let nextInsertError: { message: string } | null = null

  const client = {
    from: (table: string) => {
      if (table !== 'ooo_replies_sent') {
        throw new Error(`unexpected table: ${table}`)
      }
      const filters: Array<{ col: string; value: unknown }> = []
      let mode: 'select' | 'insert' = 'select'
      let pendingInsert: Insert | null = null
      const chain: Record<string, unknown> = {
        select: () => {
          mode = 'select'
          return chain
        },
        eq: (col: string, value: unknown) => {
          filters.push({ col, value })
          return chain
        },
        limit: () => chain,
        maybeSingle: async () => {
          if (nextSelectError) {
            const e = nextSelectError
            nextSelectError = null
            return { data: null, error: e }
          }
          const conv = filters.find((f) => f.col === 'conversation_id')?.value
          const win = filters.find((f) => f.col === 'ooo_window_start')?.value
          const found = inserts.find(
            (r) => r.conversation_id === conv && r.ooo_window_start === win
          )
          return { data: found ?? null, error: null }
        },
        insert: (row: Insert) => {
          mode = 'insert'
          pendingInsert = row
          // Insert returns a thenable directly in production (no await on a chained method).
          return {
            then: (resolve: (v: unknown) => unknown) => {
              if (nextInsertError) {
                const e = nextInsertError
                nextInsertError = null
                return Promise.resolve({ error: e }).then(resolve)
              }
              if (
                pendingInsert &&
                inserts.some(
                  (r) =>
                    r.conversation_id === pendingInsert!.conversation_id &&
                    r.ooo_window_start === pendingInsert!.ooo_window_start
                )
              ) {
                return Promise.resolve({ error: { code: '23505', message: 'duplicate' } }).then(
                  resolve
                )
              }
              if (pendingInsert) inserts.push(pendingInsert)
              return Promise.resolve({ error: null }).then(resolve)
            },
          }
        },
      }
      // Suppress unused-variable warning for `mode` (kept for parity with insert/select branches).
      void mode
      return chain
    },
  } as unknown as SupabaseClient

  return {
    client,
    inserts,
    setSelectError(err: { message: string } | null) {
      nextSelectError = err
    },
    setInsertError(err: { message: string } | null) {
      nextInsertError = err
    },
  }
}

describe('shouldSendOOOReply', () => {
  it('returns true when no row exists for the (conversation, window)', async () => {
    const { client } = makeStub()
    const ok = await shouldSendOOOReply(client, 'acct', 'conv1', '2026-05-01T00:00:00Z')
    expect(ok).toBe(true)
  })

  it('returns false when a dedup row already exists', async () => {
    const { client } = makeStub([
      { account_id: 'acct', conversation_id: 'conv1', ooo_window_start: '2026-05-01T00:00:00.000Z' },
    ])
    const ok = await shouldSendOOOReply(client, 'acct', 'conv1', '2026-05-01T00:00:00Z')
    expect(ok).toBe(false)
  })

  it('treats null window-start as the unix epoch sentinel', async () => {
    const { client } = makeStub([
      { account_id: 'acct', conversation_id: 'conv1', ooo_window_start: '1970-01-01T00:00:00.000Z' },
    ])
    const ok = await shouldSendOOOReply(client, 'acct', 'conv1', null)
    expect(ok).toBe(false)
  })

  it('different windows are independent', async () => {
    const { client } = makeStub([
      { account_id: 'acct', conversation_id: 'conv1', ooo_window_start: '2026-05-01T00:00:00.000Z' },
    ])
    // A new window for the same conversation should still be allowed.
    const ok = await shouldSendOOOReply(client, 'acct', 'conv1', '2026-05-15T00:00:00Z')
    expect(ok).toBe(true)
  })

  it('returns false on missing ids', async () => {
    const { client } = makeStub()
    expect(await shouldSendOOOReply(client, '', 'conv1', null)).toBe(false)
    expect(await shouldSendOOOReply(client, 'acct', '', null)).toBe(false)
  })

  it('fails closed (returns false) on supabase error', async () => {
    const stub = makeStub()
    stub.setSelectError({ message: 'boom' })
    const ok = await shouldSendOOOReply(stub.client, 'acct', 'conv1', null)
    expect(ok).toBe(false)
  })
})

describe('recordOOOReply', () => {
  it('inserts a new dedup row', async () => {
    const stub = makeStub()
    const ok = await recordOOOReply(stub.client, 'acct', 'conv1', '2026-05-01T00:00:00Z')
    expect(ok).toBe(true)
    expect(stub.inserts.length).toBe(1)
    expect(stub.inserts[0].conversation_id).toBe('conv1')
  })

  it('returns false when the row already exists (race loser)', async () => {
    const stub = makeStub([
      { account_id: 'acct', conversation_id: 'conv1', ooo_window_start: '2026-05-01T00:00:00.000Z' },
    ])
    const ok = await recordOOOReply(stub.client, 'acct', 'conv1', '2026-05-01T00:00:00Z')
    expect(ok).toBe(false)
  })

  it('returns false on insert error', async () => {
    const stub = makeStub()
    stub.setInsertError({ message: 'rls denied' })
    const ok = await recordOOOReply(stub.client, 'acct', 'conv1', null)
    expect(ok).toBe(false)
  })

  it('returns false on missing ids', async () => {
    const stub = makeStub()
    expect(await recordOOOReply(stub.client, '', 'conv1', null)).toBe(false)
    expect(await recordOOOReply(stub.client, 'acct', '', null)).toBe(false)
  })
})

// ─── substituteOOOVariables ───────────────────────────────────────────

describe('substituteOOOVariables', () => {
  it('replaces customer.name and company.name', () => {
    const out = substituteOOOVariables(
      'Hi {{customer.name}}, this is {{company.name}}.',
      { customer: { name: 'Alice' }, company: { name: 'Acme' } }
    )
    expect(out).toBe('Hi Alice, this is Acme.')
  })

  it('renders ooo.return_date from ends_at', () => {
    const out = substituteOOOVariables('back on {{ooo.return_date}}', {
      ooo: { ends_at: '2026-05-15T09:00:00Z' },
    })
    // Local-time formatting — derive expected from same date instance.
    const d = new Date('2026-05-15T09:00:00Z')
    const yyyy = d.getFullYear()
    const mm = String(d.getMonth() + 1).padStart(2, '0')
    const dd = String(d.getDate()).padStart(2, '0')
    expect(out).toBe(`back on ${yyyy}-${mm}-${dd}`)
  })

  it('renders empty string for missing ooo.return_date', () => {
    expect(substituteOOOVariables('back on {{ooo.return_date}}', {})).toBe('back on ')
    expect(
      substituteOOOVariables('back on {{ooo.return_date}}', { ooo: { ends_at: null } })
    ).toBe('back on ')
  })

  it('falls back to customer.email when name missing', () => {
    expect(
      substituteOOOVariables('Hi {{customer.name}}', {
        customer: { name: null, email: 'x@y.com' },
      })
    ).toBe('Hi x@y.com')
  })

  it('strips HTML tags from substituted values', () => {
    expect(
      substituteOOOVariables('Hi {{customer.name}}', {
        customer: { name: '<script>x</script>Alice' },
      })
    ).toBe('Hi xAlice')
  })

  it('strips markdown link syntax', () => {
    expect(
      substituteOOOVariables('See {{customer.name}}', {
        customer: { name: '[click](http://evil/)' },
      })
    ).toBe('See click')
  })

  it('leaves unknown variables untouched', () => {
    expect(substituteOOOVariables('{{foo}}', {})).toBe('{{foo}}')
  })

  it('handles empty / whitespace-only values gracefully', () => {
    expect(substituteOOOVariables('', {})).toBe('')
    expect(
      substituteOOOVariables('Hi {{customer.name}}!', {})
    ).toBe('Hi !')
  })

  it('exposes the canonical variable list', () => {
    expect(OOO_VARIABLES).toContain('customer.name')
    expect(OOO_VARIABLES).toContain('ooo.return_date')
    expect(OOO_VARIABLES).toContain('company.name')
  })
})
