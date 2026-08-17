import { describe, expect, it } from 'vitest'
import { dayDetailState } from './dayDetailAction'

const NOW = Date.parse('2026-08-17T12:00:00.000Z')
const ago = (ms: number) => new Date(NOW - ms).toISOString()

/**
 * "Route eagerly, detail lazily": a day past the eager window carries its
 * route and no detail until it is opened.
 */
describe('dayDetailState', () => {
  // Absent means ready. Every day written before the split carries its
  // detail already, and a trip planned last week must not come back looking
  // like it lost half of itself.
  it('treats a day with no detailStatus as ready', () => {
    expect(dayDetailState({}, NOW)).toBe('ready')
  })

  it('reports a detailed day as ready', () => {
    expect(dayDetailState({ detailStatus: 'ready' }, NOW)).toBe('ready')
  })

  it('reports a day waiting to be worked out as pending', () => {
    expect(dayDetailState({ detailStatus: 'pending' }, NOW)).toBe('pending')
  })

  it('reports a run that beat recently as working', () => {
    expect(
      dayDetailState(
        { detailStatus: 'generating', detailStatusUpdatedAt: ago(30_000) },
        NOW,
      ),
    ).toBe('working')
  })

  // The heartbeat is what tells a slow run from a container that died. A
  // status written once could only ever say "assume alive", which is how a
  // spinner ends up on screen forever.
  it('reports a run that stopped beating as stalled', () => {
    expect(
      dayDetailState(
        { detailStatus: 'generating', detailStatusUpdatedAt: ago(5 * 60_000) },
        NOW,
      ),
    ).toBe('stalled')
  })

  // A run started by an older deploy has no heartbeat at all. Trusted rather
  // than declared dead: being wrong here costs a second paid Claude call.
  it('trusts a run with no heartbeat rather than declaring it dead', () => {
    expect(dayDetailState({ detailStatus: 'generating' }, NOW)).toBe('working')
  })

  it('does not trip over an unparseable heartbeat', () => {
    expect(
      dayDetailState(
        { detailStatus: 'generating', detailStatusUpdatedAt: 'not a date' },
        NOW,
      ),
    ).toBe('working')
  })
})
