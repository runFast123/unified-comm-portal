/**
 * Unit tests for the email-signature helper. Exercises:
 *   - variable substitution (known + unknown placeholders)
 *   - inheritance picker (user override > company default > none)
 *   - body appender (delimiter, double-append guard, empty signature)
 *   - the full `resolveSignature(client, userId)` flow over a mock
 *     supabase client covering happy path + edge cases.
 */

import { describe, it, expect } from 'vitest'
import {
  appendSignatureToBody,
  pickSignatureTemplate,
  resolveSignature,
  substituteSignatureVariables,
} from '@/lib/email-signature'

// ── Mock supabase factory ─────────────────────────────────────────────
// Mirrors the chain shape used inside `resolveSignature`. Pass `tables`
// keyed by table name; each entry is the row returned for `.eq(id|account_id|company_id)`
// followed by `.maybeSingle()`. Unspecified tables return null.
function makeClient(
  tables: Partial<{
    users: Record<string, unknown> | null
    accounts: Record<string, unknown> | null
    companies: Record<string, unknown> | null
  }>,
) {
  return {
    from(table: string) {
      const chain: Record<string, unknown> = {}
      ;(chain as { select: (..._a: unknown[]) => unknown }).select = () => chain
      ;(chain as { eq: (..._a: unknown[]) => unknown }).eq = () => chain
      ;(chain as { maybeSingle: () => Promise<{ data: unknown; error: null }> }).maybeSingle =
        async () => {
          const row =
            table === 'users' ? tables.users ?? null :
            table === 'accounts' ? tables.accounts ?? null :
            table === 'companies' ? tables.companies ?? null :
            null
          return { data: row, error: null }
        }
      return chain
    },
  }
}

describe('substituteSignatureVariables', () => {
  it('substitutes known variables', () => {
    const out = substituteSignatureVariables(
      'Hi from {{user.full_name}} <{{user.email}}> @ {{company.name}} on {{date}}',
      {
        user: { id: 'u1', full_name: 'Jane Doe', email: 'jane@acme.com' },
        company: { name: 'Acme Corp' },
        date: '2026-04-30',
      },
    )
    expect(out).toBe('Hi from Jane Doe <jane@acme.com> @ Acme Corp on 2026-04-30')
  })

  it('leaves unknown placeholders intact', () => {
    const out = substituteSignatureVariables(
      '{{user.handle}} - {{user.full_name}}',
      {
        user: { id: 'u1', full_name: 'Jane', email: null },
        company: { name: 'Acme' },
        date: '2026-01-01',
      },
    )
    expect(out).toBe('{{user.handle}} - Jane')
  })

  it('substitutes nulls as empty strings', () => {
    const out = substituteSignatureVariables(
      'Name: {{user.full_name}} | Email: {{user.email}}',
      {
        user: { id: 'u1', full_name: null, email: null },
        company: { name: null },
        date: '2026-01-01',
      },
    )
    expect(out).toBe('Name:  | Email: ')
  })

  it('handles whitespace inside the placeholder', () => {
    const out = substituteSignatureVariables(
      'Hi {{ user.full_name }}',
      {
        user: { id: 'u1', full_name: 'Pat', email: null },
        company: { name: null },
        date: 'd',
      },
    )
    expect(out).toBe('Hi Pat')
  })
})

describe('pickSignatureTemplate', () => {
  it('user override wins when set + enabled', () => {
    expect(
      pickSignatureTemplate({
        user_signature: 'mine',
        user_signature_enabled: true,
        company_default: 'theirs',
      }),
    ).toBe('mine')
  })

  it('falls back to company default when user disabled', () => {
    expect(
      pickSignatureTemplate({
        user_signature: 'mine',
        user_signature_enabled: false,
        company_default: 'theirs',
      }),
    ).toBe('theirs')
  })

  it('falls back to company default when user signature is empty/whitespace', () => {
    expect(
      pickSignatureTemplate({
        user_signature: '   ',
        user_signature_enabled: true,
        company_default: 'theirs',
      }),
    ).toBe('theirs')
  })

  it('returns null when both are missing', () => {
    expect(
      pickSignatureTemplate({
        user_signature: null,
        user_signature_enabled: true,
        company_default: null,
      }),
    ).toBeNull()
  })

  it('treats null user_signature_enabled as default-true', () => {
    expect(
      pickSignatureTemplate({
        user_signature: 'mine',
        user_signature_enabled: null,
        company_default: 'theirs',
      }),
    ).toBe('mine')
  })
})

describe('appendSignatureToBody', () => {
  it('appends with the standard delimiter', () => {
    const out = appendSignatureToBody('Hello there.', 'Jane Doe\nAcme Corp')
    expect(out).toBe('Hello there.\n\n---\nJane Doe\nAcme Corp')
  })

  it('returns body untouched when signature is null', () => {
    expect(appendSignatureToBody('Hi', null)).toBe('Hi')
  })

  it('returns body untouched when signature is whitespace-only', () => {
    expect(appendSignatureToBody('Hi', '   \n\n')).toBe('Hi')
  })

  it('does not double-append when the first 30 chars already appear', () => {
    const sig = 'Jane Doe\nSupport Manager — Acme Corp\njane@acme.com'
    const body = `Hi customer,\n\nThanks for writing.\n\n${sig}`
    expect(appendSignatureToBody(body, sig)).toBe(body)
  })

  it('strips trailing whitespace before appending', () => {
    const out = appendSignatureToBody('Body\n\n   \n', 'Sig')
    expect(out).toBe('Body\n\n---\nSig')
  })
})

describe('resolveSignature', () => {
  it('returns the user override (substituted) when set + enabled', async () => {
    const client = makeClient({
      users: {
        id: 'u1',
        email: 'jane@acme.com',
        full_name: 'Jane Doe',
        email_signature: 'Cheers,\n{{user.full_name}}',
        email_signature_enabled: true,
        account_id: 'acc-1',
      },
      accounts: { company_id: 'co-1' },
      companies: { name: 'Acme', default_email_signature: 'COMPANY DEFAULT' },
    })
    const out = await resolveSignature(client, 'u1', { now: new Date('2026-04-30T00:00:00Z') })
    expect(out).toBe('Cheers,\nJane Doe')
  })

  it('returns the company default when the user opt-out flag is false', async () => {
    const client = makeClient({
      users: {
        id: 'u1',
        email: 'jane@acme.com',
        full_name: 'Jane Doe',
        email_signature: 'should-not-be-used',
        email_signature_enabled: false,
        account_id: 'acc-1',
      },
      accounts: { company_id: 'co-1' },
      companies: { name: 'Acme', default_email_signature: 'The Acme Team' },
    })
    const out = await resolveSignature(client, 'u1')
    expect(out).toBe('The Acme Team')
  })

  it('substitutes company.name in the company default', async () => {
    const client = makeClient({
      users: {
        id: 'u1',
        email: 'jane@acme.com',
        full_name: 'Jane',
        email_signature: null,
        email_signature_enabled: true,
        account_id: 'acc-1',
      },
      accounts: { company_id: 'co-1' },
      companies: { name: 'Acme', default_email_signature: '— The {{company.name}} team' },
    })
    const out = await resolveSignature(client, 'u1')
    expect(out).toBe('— The Acme team')
  })

  it('returns null when user has no override AND no company default', async () => {
    const client = makeClient({
      users: {
        id: 'u1',
        email: null,
        full_name: null,
        email_signature: null,
        email_signature_enabled: true,
        account_id: 'acc-1',
      },
      accounts: { company_id: 'co-1' },
      companies: { name: 'Acme', default_email_signature: null },
    })
    const out = await resolveSignature(client, 'u1')
    expect(out).toBeNull()
  })

  it('returns null when the user row itself is missing', async () => {
    const client = makeClient({ users: null })
    const out = await resolveSignature(client, 'missing-user')
    expect(out).toBeNull()
  })

  it('falls back to the user override when the account is unlinked (no company)', async () => {
    const client = makeClient({
      users: {
        id: 'u1',
        email: 'a@b.c',
        full_name: 'Solo',
        email_signature: 'just me',
        email_signature_enabled: true,
        account_id: null,
      },
    })
    const out = await resolveSignature(client, 'u1')
    expect(out).toBe('just me')
  })

  it('returns null for empty userId', async () => {
    const client = makeClient({})
    const out = await resolveSignature(client, '')
    expect(out).toBeNull()
  })
})
