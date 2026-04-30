import { vi } from 'vitest'

// Mock must be declared before the import of the module-under-test below.
vi.mock('@/lib/rate-limiter', () => ({
  checkRateLimit: vi.fn(),
}))

import { checkRateLimit as wrapperCheck } from '@/lib/api-helpers'
import { checkRateLimit as mockedRpc } from '@/lib/rate-limiter'

const mock = mockedRpc as unknown as ReturnType<typeof vi.fn>

describe('api-helpers rate-limit wrapper', () => {
  beforeEach(() => {
    mock.mockReset()
  })

  it('returns true when the DB-backed limiter allows', async () => {
    mock.mockResolvedValueOnce({
      allowed: true,
      remaining: 42,
      reset_at: new Date(),
    })
    const result = await wrapperCheck('key:a', 100, 60)
    expect(result).toBe(true)
    expect(mock).toHaveBeenCalledWith('key:a', 100, 60)
  })

  it('returns false when the DB-backed limiter denies', async () => {
    mock.mockResolvedValueOnce({
      allowed: false,
      remaining: 0,
      reset_at: new Date(),
    })
    const result = await wrapperCheck('key:b', 5, 30)
    expect(result).toBe(false)
  })

  it('fails open (allows) when the DB-backed limiter itself returns a fail-open result after a thrown RPC', async () => {
    // `@/lib/rate-limiter` catches internally and returns `{allowed:true, ...}` — the
    // wrapper just surfaces whatever `allowed` is. Simulate that contract here.
    mock.mockResolvedValueOnce({
      allowed: true,
      remaining: 100,
      reset_at: new Date(Date.now() + 60_000),
    })
    const result = await wrapperCheck('key:c')
    expect(result).toBe(true)
  })

  it('propagates if the dependency unexpectedly throws (documents current behavior)', async () => {
    // The wrapper has no try/catch — it relies on rate-limiter.ts to fail-open
    // internally. If that guarantee is ever broken, this test will start to
    // fail and alert us to wrap a try/catch in api-helpers too.
    mock.mockRejectedValueOnce(new Error('boom'))
    await expect(wrapperCheck('key:d')).rejects.toThrow('boom')
  })
})
