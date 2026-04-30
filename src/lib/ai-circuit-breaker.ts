/**
 * AI Circuit Breaker — short-circuit upstream AI calls when the provider
 * (NVIDIA NIM today) is failing repeatedly.
 *
 * Standard 3-state breaker:
 *   - CLOSED    — every request goes through
 *   - OPEN      — every request short-circuits with `CircuitBreakerOpenError`
 *                 immediately, no upstream call. Stays open for `cooldownMs`.
 *   - HALF_OPEN — first request after cooldown is allowed through as a
 *                 canary. Success → CLOSED, failure → OPEN (full cooldown).
 *
 * Lives entirely in-process. There is no DB persistence — the cron retries
 * will reopen the breaker quickly enough on the next failure if the outage
 * persists across instance hops, and persisting state would be a meaningful
 * extra round-trip on every AI call.
 *
 * The breaker only counts PROVIDER faults as failures:
 *   - network errors (fetch throws / timeouts)
 *   - non-2xx HTTP responses (5xx, 503, etc)
 *   - body parse errors
 *
 * The following are NOT failures (they bubble up but don't trip the breaker):
 *   - `AIBudgetExceededError` — per-account limit, not a provider problem
 *   - 4xx responses indicating bad-request (400, 401, 403) — caller bugs,
 *     retrying won't help
 *
 * Usage:
 *   const result = await withCircuitBreaker(async () => {
 *     // existing fetch + parse logic that throws on provider errors
 *     return await callUpstream()
 *   })
 */

import { logInfo, logError } from '@/lib/logger'
import { AIBudgetExceededError } from '@/lib/ai-usage'

// ─── Public types ───────────────────────────────────────────────────
export type CircuitBreakerState = 'CLOSED' | 'OPEN' | 'HALF_OPEN'

export class CircuitBreakerOpenError extends Error {
  constructor(message = 'AI provider circuit breaker is open') {
    super(message)
    this.name = 'CircuitBreakerOpenError'
  }
}

// ─── Configuration ──────────────────────────────────────────────────
export interface CircuitBreakerConfig {
  /** Open after this many consecutive failures. Default: 5. */
  failureThreshold: number
  /** Cooldown before transitioning OPEN → HALF_OPEN (ms). Default: 60_000. */
  cooldownMs: number
}

const DEFAULT_CONFIG: CircuitBreakerConfig = {
  failureThreshold: 5,
  cooldownMs: 60_000,
}

// ─── In-process state ───────────────────────────────────────────────
interface BreakerState {
  state: CircuitBreakerState
  consecutiveFailures: number
  /** Wall-clock time the breaker last transitioned to OPEN. */
  openedAt: number | null
  /** Last error message captured when the breaker opened (for diagnostics). */
  lastErrorMessage: string | null
}

const breaker: BreakerState = {
  state: 'CLOSED',
  consecutiveFailures: 0,
  openedAt: null,
  lastErrorMessage: null,
}

let activeConfig: CircuitBreakerConfig = { ...DEFAULT_CONFIG }

// ─── Failure classification ─────────────────────────────────────────
/**
 * Returns true when an error from the wrapped function should count as a
 * provider failure (i.e. should advance the failure counter / open the
 * breaker). Returns false for caller-side errors that won't be helped by
 * any amount of upstream retrying.
 */
export function isProviderFailure(err: unknown): boolean {
  if (err instanceof AIBudgetExceededError) return false
  if (err instanceof CircuitBreakerOpenError) return false

  // Inspect HTTP status codes embedded in the error message — `callAI`
  // currently throws `Error("AI API error (NNN): ...")` so this regex
  // captures the same shape. Bad-request 4xx are caller bugs.
  if (err instanceof Error && err.message) {
    const m = err.message.match(/\b(\d{3})\b/)
    if (m) {
      const status = Number(m[1])
      if (status === 400 || status === 401 || status === 403 || status === 404 || status === 422) {
        return false
      }
    }
  }
  return true
}

// ─── State transitions ──────────────────────────────────────────────
function transitionToOpen(errorMessage: string): void {
  const wasOpen = breaker.state === 'OPEN'
  breaker.state = 'OPEN'
  breaker.openedAt = Date.now()
  breaker.lastErrorMessage = errorMessage
  // Don't double-log if a half-open canary just re-opened — we already
  // logged the half-open transition; logging the re-open is still useful.
  if (!wasOpen) {
    logError('ai', 'ai_breaker_opened', 'AI provider circuit breaker opened', {
      consecutive_failures: breaker.consecutiveFailures,
      last_error: errorMessage,
      cooldown_ms: activeConfig.cooldownMs,
    })
  } else {
    logError(
      'ai',
      'ai_breaker_opened',
      'AI provider circuit breaker re-opened after half-open canary failed',
      {
        last_error: errorMessage,
        cooldown_ms: activeConfig.cooldownMs,
      },
    )
  }
}

function transitionToHalfOpen(): void {
  breaker.state = 'HALF_OPEN'
  logInfo('ai', 'ai_breaker_half_open', 'AI provider circuit breaker entering half-open (canary)', {
    last_error: breaker.lastErrorMessage,
  })
}

function transitionToClosed(): void {
  breaker.state = 'CLOSED'
  breaker.consecutiveFailures = 0
  breaker.openedAt = null
  breaker.lastErrorMessage = null
  logInfo('ai', 'ai_breaker_closed', 'AI provider circuit breaker closed (recovered)')
}

/**
 * Pre-call gate. Possibly transitions OPEN → HALF_OPEN if the cooldown
 * has elapsed. Throws `CircuitBreakerOpenError` when the breaker should
 * short-circuit the call.
 */
function ensureCallAllowed(): void {
  if (breaker.state === 'CLOSED' || breaker.state === 'HALF_OPEN') return

  // OPEN — check cooldown.
  const openedAt = breaker.openedAt ?? 0
  const elapsed = Date.now() - openedAt
  if (elapsed >= activeConfig.cooldownMs) {
    transitionToHalfOpen()
    return
  }
  throw new CircuitBreakerOpenError(
    `AI provider circuit breaker is open (${Math.max(0, activeConfig.cooldownMs - elapsed)}ms until half-open)`,
  )
}

// ─── Public API ─────────────────────────────────────────────────────
/**
 * Wrap an async upstream-call function with circuit-breaker semantics.
 *
 * Throws `CircuitBreakerOpenError` immediately when the breaker is open.
 * Otherwise runs the function and updates breaker state based on the
 * outcome. Errors from the wrapped function are re-thrown unchanged (so
 * callers can still distinguish AIBudgetExceededError, etc.).
 */
export async function withCircuitBreaker<T>(fn: () => Promise<T>): Promise<T> {
  ensureCallAllowed()

  const wasHalfOpen = breaker.state === 'HALF_OPEN'

  try {
    const result = await fn()
    // Success — half-open canary recovered, or a successful CLOSED call
    // resets the consecutive-failure counter.
    if (wasHalfOpen) {
      transitionToClosed()
    } else if (breaker.consecutiveFailures > 0) {
      breaker.consecutiveFailures = 0
    }
    return result
  } catch (err) {
    if (!isProviderFailure(err)) {
      // Bubble up without touching breaker state — these are caller-side
      // errors (budget limit, 4xx bad-request, the breaker itself).
      throw err
    }

    const errorMessage = err instanceof Error ? err.message : String(err)

    if (wasHalfOpen) {
      // Canary failed — re-open with a full cooldown.
      transitionToOpen(errorMessage)
      throw err
    }

    breaker.consecutiveFailures += 1
    breaker.lastErrorMessage = errorMessage
    if (breaker.consecutiveFailures >= activeConfig.failureThreshold) {
      transitionToOpen(errorMessage)
    }
    throw err
  }
}

// ─── Introspection / config ─────────────────────────────────────────
export interface BreakerSnapshot {
  state: CircuitBreakerState
  consecutive_failures: number
  opened_at: number | null
  last_error_message: string | null
  cooldown_ms: number
  failure_threshold: number
}

/** Read-only snapshot of breaker state. Useful for /admin/health endpoints. */
export function getBreakerState(): BreakerSnapshot {
  return {
    state: breaker.state,
    consecutive_failures: breaker.consecutiveFailures,
    opened_at: breaker.openedAt,
    last_error_message: breaker.lastErrorMessage,
    cooldown_ms: activeConfig.cooldownMs,
    failure_threshold: activeConfig.failureThreshold,
  }
}

/**
 * Override breaker configuration at runtime. Mostly useful for tests; in
 * production we rely on the defaults.
 */
export function configureCircuitBreaker(partial: Partial<CircuitBreakerConfig>): void {
  activeConfig = { ...activeConfig, ...partial }
}

// ─── Test-only helpers ──────────────────────────────────────────────
/** Reset breaker to a pristine CLOSED state. EXPORTED FOR TESTS. */
export function __resetCircuitBreakerForTests(): void {
  breaker.state = 'CLOSED'
  breaker.consecutiveFailures = 0
  breaker.openedAt = null
  breaker.lastErrorMessage = null
  activeConfig = { ...DEFAULT_CONFIG }
}
