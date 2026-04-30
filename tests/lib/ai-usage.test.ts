import { describe, it, expect } from 'vitest'
import { estimateCostUsd, approxTokensFromText } from '@/lib/ai-usage'

describe('estimateCostUsd', () => {
  it('uses NVIDIA combined rate (0.0005/1k)', () => {
    // 1000 + 1000 = 2000 tokens combined → 0.0005 * 2 = 0.001
    expect(estimateCostUsd('nvidia/llama-3.1-70b', 1000, 1000)).toBeCloseTo(0.001, 6)
  })

  it('uses GPT-4o split rates', () => {
    // 1000 input * 0.005/1k + 1000 output * 0.015/1k = 0.005 + 0.015 = 0.02
    expect(estimateCostUsd('openai/gpt-4o', 1000, 1000)).toBeCloseTo(0.02, 6)
  })

  it('uses GPT-4 high rate', () => {
    // 1000 in + 1000 out at 0.06/1k each = 0.12
    expect(estimateCostUsd('openai/gpt-4', 1000, 1000)).toBeCloseTo(0.12, 6)
  })

  it('falls back to default when model unknown — does not throw', () => {
    // 2000 combined * 0.001/1k = 0.002
    expect(estimateCostUsd('unknown/model-xyz', 1000, 1000)).toBeCloseTo(0.002, 6)
  })

  it('handles empty/garbage model strings without throwing', () => {
    expect(estimateCostUsd('', 100, 100)).toBeGreaterThanOrEqual(0)
    expect(estimateCostUsd('   ', 0, 0)).toBe(0)
  })

  it('clamps negative token counts to 0', () => {
    expect(estimateCostUsd('nvidia/x', -50, -50)).toBe(0)
  })

  it('handles NaN tokens by treating as 0', () => {
    expect(estimateCostUsd('nvidia/x', NaN, NaN)).toBe(0)
  })
})

describe('approxTokensFromText', () => {
  it('returns 0 for null/undefined/empty', () => {
    expect(approxTokensFromText(null)).toBe(0)
    expect(approxTokensFromText(undefined)).toBe(0)
    expect(approxTokensFromText('')).toBe(0)
  })

  it('approximates ~4 chars per token', () => {
    expect(approxTokensFromText('a'.repeat(40))).toBe(10)
    expect(approxTokensFromText('a'.repeat(41))).toBe(11)
  })
})
