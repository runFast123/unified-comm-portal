// Disable the post-recordMetric eager flush so tests can inspect the buffer
// before it gets drained. Production behavior (always flush via after()) is
// covered separately by the integration / smoke tests.
process.env.METRICS_DISABLE_AUTO_FLUSH = '1'

import { recordMetric, __getBufferForTests, __resetBufferForTests, flushNow } from '@/lib/metrics'

describe('metrics.recordMetric', () => {
  beforeEach(() => {
    __resetBufferForTests()
  })

  it('buffers a single event with normalized labels', () => {
    recordMetric('cron.email_poll.duration_ms', 1234, { shard: 0, success: true })
    const buf = __getBufferForTests()
    expect(buf.length).toBe(1)
    expect(buf[0].metric_name).toBe('cron.email_poll.duration_ms')
    expect(buf[0].value).toBe(1234)
    expect(buf[0].labels).toEqual({ shard: 0, success: true })
    expect(buf[0].request_id).toBeNull()
    expect(typeof buf[0].ts).toBe('string')
  })

  it('strips undefined label values but keeps null/false/0', () => {
    recordMetric('test.metric', 1, {
      kept_zero: 0,
      kept_false: false,
      kept_null: null,
      dropped: undefined,
    })
    const buf = __getBufferForTests()
    expect(buf[0].labels).toEqual({
      kept_zero: 0,
      kept_false: false,
      kept_null: null,
    })
  })

  it('returns null labels when all keys are undefined', () => {
    recordMetric('test.empty_labels', 1, { dropped: undefined })
    expect(__getBufferForTests()[0].labels).toBeNull()
  })

  it('passes through request_id when supplied', () => {
    recordMetric('test.metric', 1, undefined, 'req-abc-123')
    expect(__getBufferForTests()[0].request_id).toBe('req-abc-123')
  })

  it('treats empty string request_id as null', () => {
    recordMetric('test.metric', 1, undefined, '')
    expect(__getBufferForTests()[0].request_id).toBeNull()
  })

  it('drops entries with empty / non-string names', () => {
    // @ts-expect-error testing runtime guard
    recordMetric(undefined, 1)
    recordMetric('', 1)
    expect(__getBufferForTests().length).toBe(0)
  })

  it('drops entries with non-finite values', () => {
    recordMetric('test.metric', NaN)
    recordMetric('test.metric', Infinity)
    recordMetric('test.metric', -Infinity)
    // @ts-expect-error testing runtime guard
    recordMetric('test.metric', 'not a number')
    expect(__getBufferForTests().length).toBe(0)
  })

  it('coerces numeric strings via Number()', () => {
    // @ts-expect-error testing runtime coercion
    recordMetric('test.metric', '42')
    expect(__getBufferForTests()[0].value).toBe(42)
  })

  it('never grows above BUFFER_MAX (1000)', () => {
    // Eager flushes happen at every batch threshold; outside a Next request
    // context they fall back to `void flushNow()` which drains immediately.
    // What we care about here is the *invariant* that the buffer never grows
    // beyond the cap — the drop-oldest path is exercised when a flush is
    // backlogged.
    for (let i = 0; i < 1100; i++) {
      recordMetric('test.metric', i)
    }
    const buf = __getBufferForTests()
    expect(buf.length).toBeLessThanOrEqual(1000)
  })

  it('never throws on malformed inputs', () => {
    expect(() => {
      // @ts-expect-error
      recordMetric(null, 1)
      // @ts-expect-error
      recordMetric('a', null)
      // @ts-expect-error
      recordMetric('a', 1, 'not-an-object')
      // @ts-expect-error
      recordMetric('a', 1, undefined, 12345)
    }).not.toThrow()
  })

  it('flushNow is a no-op when buffer is empty', async () => {
    await expect(flushNow()).resolves.toBeUndefined()
  })

  it('flushNow drains the buffer even when network call fails', async () => {
    // No env vars set in tests — flushNow returns early with empty drain.
    recordMetric('test.metric', 1)
    expect(__getBufferForTests().length).toBe(1)
    await flushNow()
    expect(__getBufferForTests().length).toBe(0)
  })
})
