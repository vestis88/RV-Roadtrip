import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The picker's real production failure was a source that never answered, not
 * one that threw: two requests on 2026-08-10 sat at latency 179.9999s against
 * the callable's own `timeoutSeconds: 180` and were killed by Cloud Run with
 * a 504. The client rendered that as "Could not load overnight options right
 * now" — the same message a genuine error produces, which is why it read as
 * broken code rather than as a timeout.
 *
 * These exercise the deadline helper through the real module, with fake
 * timers so a 60s budget costs no wall time.
 */
const { __testing } = await import('./overnightCandidatesCallable.js')
const { withDeadline } = __testing

const candidate = (name: string) =>
  ({ name, kind: 'campsite', lat: 1, lng: 2 }) as never

describe('withDeadline', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('passes a prompt source straight through', async () => {
    const result = await withDeadline(
      Promise.resolve([candidate('Lillehammer Camping')]),
      'campsite search (Places)',
      60_000,
    )
    expect(result).toHaveLength(1)
  })

  // The regression. Before this, Promise.all waited forever and the whole
  // callable died at the platform ceiling.
  it('gives up on a source that never settles', async () => {
    const neverSettles = new Promise<never>(() => {})
    const pending = withDeadline(neverSettles, 'stellplatz (Overpass)', 60_000)

    await vi.advanceTimersByTimeAsync(60_000)

    expect(await pending).toEqual([])
  })

  it('still degrades a source that throws, as before', async () => {
    const result = await withDeadline(
      Promise.reject(new Error('Overpass query failed with 406')),
      'stellplatz (Overpass)',
      60_000,
    )
    expect(result).toEqual([])
  })

  // A rejection arriving after we stopped listening must not become an
  // unhandled rejection — that would take the instance down well after the
  // response had already been returned.
  it('swallows a rejection that lands after the deadline passed', async () => {
    let fail: (error: Error) => void = () => {}
    const late = new Promise<never>((_, reject) => {
      fail = reject
    })
    const pending = withDeadline(late, 'wild camping (Claude)', 60_000)

    await vi.advanceTimersByTimeAsync(60_000)
    expect(await pending).toEqual([])

    fail(new Error('arrived far too late'))
    await expect(late.catch(() => 'handled')).resolves.toBe('handled')
  })

  it('does not leave a timer holding the process open when the source wins', async () => {
    await withDeadline(Promise.resolve([]), 'campsite search (Places)', 60_000)
    expect(vi.getTimerCount()).toBe(0)
  })
})
