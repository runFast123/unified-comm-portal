// Tests the in-process AI provider circuit breaker.
//
// Coverage:
//   * Closed by default
//   * Opens after N consecutive failures
//   * Short-circuits while open (no upstream call)
//   * After cooldown, single half-open request goes through
//   * Half-open success → CLOSED
//   * Half-open failure → reopens (back to OPEN, full cooldown)
//   * Successful call resets the failure counter
//   * AIBudgetExceededError is NOT counted as a provider failure
//   * 4xx caller-side errors (400/401/403) are NOT counted as failures
//
// We stub the structured logger so the test runs stay quiet, and we set
// `vi.useFakeTimers()` to advance the cooldown deterministically.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

vi.mock('@/lib/logger', () => ({
  logError: vi.fn(),
  logWarn: vi.fn(),
  logInfo: vi.fn(),
}))

import {
  withCircuitBreaker,
  CircuitBreakerOpenError,
  isProviderFailure,
  getBreakerState,
  configureCircuitBreaker,
  __resetCircuitBreakerForTests,
} from '@/lib/ai-circuit-breaker'
import { AIBudgetExceededError } from '@/lib/ai-usage'

// Convenience helper: a wrapped function that always throws a generic
// provider error.
function failingFn(message = 'AI API error (503): upstream broke'): () => Promise<string> {
  return async () => {
    throw new Error(message)
  }
}

function succeedingFn(value = 'ok'): () => Promise<string> {
  return async () => value
}

describe('ai-circuit-breaker', () => {
  beforeEach(() => {
    __resetCircuitBreakerForTests()
    // Tighten thresholds for faster tests — but the defaults match prod.
    configureCircuitBreaker({ failureThreshold: 5, cooldownMs: 60_000 })
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    __resetCircuitBreakerForTests()
  })

  // ─── Default state ────────────────────────────────────────────────
  it('is CLOSED by default — first call goes through', async () => {
    expect(getBreakerState().state).toBe('CLOSED')
    const result = await withCircuitBreaker(succeedingFn('hello'))
    expect(result).toBe('hello')
    expect(getBreakerState().state).toBe('CLOSED')
    expect(getBreakerState().consecutive_failures).toBe(0)
  })

  // ─── Failure accumulation + open ──────────────────────────────────
  it('opens after N consecutive failures', async () => {
    // First 4 failures keep it CLOSED but with a rising counter.
    for (let i = 0; i < 4; i++) {
      await expect(withCircuitBreaker(failingFn())).rejects.toThrow(/503/)
      expect(getBreakerState().state).toBe('CLOSED')
      expect(getBreakerState().consecutive_failures).toBe(i + 1)
    }
    // 5th failure trips the breaker.
    await expect(withCircuitBreaker(failingFn())).rejects.toThrow(/503/)
    expect(getBreakerState().state).toBe('OPEN')
    expect(getBreakerState().consecutive_failures).toBe(5)
  })

  it('short-circuits while OPEN — wrapped function is never invoked', async () => {
    // Trip the breaker.
    for (let i = 0; i < 5; i++) {
      await expect(withCircuitBreaker(failingFn())).rejects.toThrow()
    }
    expect(getBreakerState().state).toBe('OPEN')

    // The wrapped function must not be called now.
    const upstream = vi.fn(succeedingFn('should-not-run'))
    await expect(withCircuitBreaker(upstream)).rejects.toBeInstanceOf(
      CircuitBreakerOpenError,
    )
    expect(upstream).not.toHaveBeenCalled()
  })

  // ─── Cooldown → HALF_OPEN ─────────────────────────────────────────
  it('after cooldown, the next request transitions to HALF_OPEN and goes through', async () => {
    for (let i = 0; i < 5; i++) {
      await expect(withCircuitBreaker(failingFn())).rejects.toThrow()
    }
    expect(getBreakerState().state).toBe('OPEN')

    // Advance past cooldown.
    vi.advanceTimersByTime(60_001)

    // Canary call goes through; on success the breaker closes.
    const upstream = vi.fn(succeedingFn('recovered'))
    const result = await withCircuitBreaker(upstream)
    expect(result).toBe('recovered')
    expect(upstream).toHaveBeenCalledTimes(1)
    expect(getBreakerState().state).toBe('CLOSED')
    expect(getBreakerState().consecutive_failures).toBe(0)
  })

  it('HALF_OPEN failure re-opens the breaker with a full cooldown', async () => {
    // Trip and cool down.
    for (let i = 0; i < 5; i++) {
      await expect(withCircuitBreaker(failingFn())).rejects.toThrow()
    }
    expect(getBreakerState().state).toBe('OPEN')
    const firstOpenedAt = getBreakerState().opened_at!
    expect(typeof firstOpenedAt).toBe('number')

    vi.advanceTimersByTime(60_001)

    // Canary call fails — should re-open with refreshed cooldown timer.
    const failingCanary = vi.fn(failingFn('AI API error (502): upstream still bad'))
    await expect(withCircuitBreaker(failingCanary)).rejects.toThrow(/502/)
    expect(failingCanary).toHaveBeenCalledTimes(1)
    expect(getBreakerState().state).toBe('OPEN')

    // The new openedAt should be later than the original.
    const reopenedAt = getBreakerState().opened_at!
    expect(reopenedAt).toBeGreaterThan(firstOpenedAt)

    // Subsequent calls short-circuit again (full cooldown reset).
    const upstream = vi.fn(succeedingFn())
    await expect(withCircuitBreaker(upstream)).rejects.toBeInstanceOf(
      CircuitBreakerOpenError,
    )
    expect(upstream).not.toHaveBeenCalled()
  })

  // ─── Counter reset ────────────────────────────────────────────────
  it('successful call resets the consecutive-failure counter', async () => {
    // 3 failures.
    for (let i = 0; i < 3; i++) {
      await expect(withCircuitBreaker(failingFn())).rejects.toThrow()
    }
    expect(getBreakerState().consecutive_failures).toBe(3)

    // One success — counter resets.
    const result = await withCircuitBreaker(succeedingFn('ok'))
    expect(result).toBe('ok')
    expect(getBreakerState().state).toBe('CLOSED')
    expect(getBreakerState().consecutive_failures).toBe(0)

    // 4 more failures should NOT trip yet (because counter restarted).
    for (let i = 0; i < 4; i++) {
      await expect(withCircuitBreaker(failingFn())).rejects.toThrow()
    }
    expect(getBreakerState().state).toBe('CLOSED')
    expect(getBreakerState().consecutive_failures).toBe(4)
  })

  // ─── Non-provider failures ────────────────────────────────────────
  it('does NOT count AIBudgetExceededError as a failure (caller still throws it)', async () => {
    const budgetError = new AIBudgetExceededError('acc-1', 51, 50)
    const wrapped = async () => {
      throw budgetError
    }

    // Repeat well past the threshold — breaker must stay CLOSED.
    for (let i = 0; i < 10; i++) {
      await expect(withCircuitBreaker(wrapped)).rejects.toBe(budgetError)
    }
    expect(getBreakerState().state).toBe('CLOSED')
    expect(getBreakerState().consecutive_failures).toBe(0)
  })

  it('does NOT count 4xx caller-side errors (400/401/403) as failures', async () => {
    for (const status of [400, 401, 403]) {
      __resetCircuitBreakerForTests()
      configureCircuitBreaker({ failureThreshold: 5, cooldownMs: 60_000 })
      const wrapped = failingFn(`AI API error (${status}): bad request`)
      for (let i = 0; i < 10; i++) {
        await expect(withCircuitBreaker(wrapped)).rejects.toThrow()
      }
      expect(getBreakerState().state).toBe('CLOSED')
      expect(getBreakerState().consecutive_failures).toBe(0)
    }
  })

  // ─── Direct unit test of the classifier ───────────────────────────
  it('isProviderFailure correctly classifies common error shapes', () => {
    // Provider faults:
    expect(isProviderFailure(new Error('AI API error (503): outage'))).toBe(true)
    expect(isProviderFailure(new Error('AI API error (500): boom'))).toBe(true)
    expect(isProviderFailure(new Error('fetch failed: ECONNRESET'))).toBe(true)
    const abort = new Error('aborted')
    abort.name = 'AbortError'
    expect(isProviderFailure(abort)).toBe(true)

    // Caller-side errors (do NOT count):
    expect(isProviderFailure(new AIBudgetExceededError('acc-1', 51, 50))).toBe(false)
    expect(isProviderFailure(new Error('AI API error (400): bad json'))).toBe(false)
    expect(isProviderFailure(new Error('AI API error (401): unauthorized'))).toBe(false)
    expect(isProviderFailure(new Error('AI API error (403): forbidden'))).toBe(false)
    expect(isProviderFailure(new CircuitBreakerOpenError())).toBe(false)
  })
})
