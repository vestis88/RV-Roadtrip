import { describe, expect, it, vi } from 'vitest'
import {
  DETAIL_WINDOW_LABEL,
  describeDetailWindow,
  NON_INVALIDATING_SETTINGS,
} from './detailWindow'

const updateDocMock = vi.fn().mockResolvedValue(undefined)
vi.mock('firebase/firestore', () => ({
  doc: (_db: unknown, ..._path: string[]) => ({ id: _path[_path.length - 1] }),
  updateDoc: (ref: { id: string }, data: unknown) => updateDocMock(ref.id, data),
  // Stands in for the real sentinel so the assertions below can see which
  // settings were recorded, not just that something was.
  arrayUnion: (...values: string[]) => ({ arrayUnion: values }),
}))
vi.mock('./firebase', () => ({ db: {} }))

const { updateTripSettings } = await import('./updateTripSettings')

// Reported 2026-08-17: "Asked to plan 2 days. Got all." Set to 2 on a
// six-day trip, the plan came back with all six days routed — which is
// correct and necessary, and which "Plan ahead: 2 days" gave every reason to
// read as a bug. The label and this sentence are the fix; the behaviour was
// never the problem.
describe('describeDetailWindow', () => {
  it('leads with the whole trip being routed, rather than mentioning it second', () => {
    const said = describeDetailWindow(3)
    expect(said).toMatch(/^Your whole trip is always routed/)
    expect(said).toMatch(/every night’s town and every drive/i)
  })

  // The old opening — "The first N days are filled in up front" — is the
  // sentence that reads as "and the rest are not planned".
  it('never opens by counting the days that are filled in', () => {
    expect(describeDetailWindow(3)).not.toMatch(/^The first/)
  })

  it('names the number of days it was given', () => {
    expect(describeDetailWindow(5)).toContain('next 5 days')
  })

  it('reads correctly at one day', () => {
    expect(describeDetailWindow(1)).toContain('today only')
    expect(describeDetailWindow(1)).not.toContain('1 days')
  })

  it('says what the window is actually made of', () => {
    expect(describeDetailWindow(3)).toMatch(/activities and.*restaurants/i)
  })

  // Not a warning against choosing it — a two-week window is allowed. Just
  // the part of the trade that is otherwise invisible.
  it('mentions the cost only once the window is long', () => {
    expect(describeDetailWindow(3)).not.toMatch(/takes longer/i)
    expect(describeDetailWindow(14)).toMatch(/takes longer/i)
    expect(describeDetailWindow(14)).toMatch(/re-planning redoes all of them/i)
  })
})

// A finished plan going stale means "Re-plan trip" — a full, paid
// regeneration. Every other setting earns that; this one does not, because
// the lazy path applies the new number the moment it is written.
describe('updateTripSettings — what actually invalidates a plan', () => {
  it('leaves a ready plan alone when only the detail window changed', async () => {
    updateDocMock.mockClear()
    await updateTripSettings('trip1', { detailWindowDays: 7 }, 'ready')

    const [, written] = updateDocMock.mock.calls[0]
    expect(written).toEqual({ 'settings.detailWindowDays': 7 })
    expect(written).not.toHaveProperty('planMeta.status')
  })

  it('still marks a ready plan stale for a setting the days were built on', async () => {
    updateDocMock.mockClear()
    await updateTripSettings('trip1', { endDate: '2026-07-20' }, 'ready')

    const [, written] = updateDocMock.mock.calls[0]
    expect(written).toMatchObject({ 'planMeta.status': 'stale' })
    // Recorded by name: a date-only staleness can be answered by re-dating
    // the days, and nothing else can, so the reason has to survive the write.
    expect(written).toMatchObject({
      'planMeta.staleSettings': { arrayUnion: ['endDate'] },
    })
  })

  // A single edit carrying both is an edit that invalidates.
  it('marks stale when an invalidating setting rides along with the window', async () => {
    updateDocMock.mockClear()
    await updateTripSettings(
      'trip1',
      { detailWindowDays: 7, endDate: '2026-07-20' },
      'ready',
    )

    const [, written] = updateDocMock.mock.calls[0]
    expect(written).toMatchObject({ 'planMeta.status': 'stale' })
    // Only the invalidating half is recorded — the window rode along and is
    // not a reason for anything.
    expect(written).toMatchObject({
      'planMeta.staleSettings': { arrayUnion: ['endDate'] },
    })
  })

  // The existing rule, unchanged: only a ready plan has anything to lose.
  it('never marks a trip that has no plan yet', async () => {
    updateDocMock.mockClear()
    await updateTripSettings('trip1', { endDate: '2026-07-20' }, 'idle')

    const [, written] = updateDocMock.mock.calls[0]
    expect(written).not.toHaveProperty('planMeta.status')
  })

  it('is named for what it controls, not for planning the trip', () => {
    expect(DETAIL_WINDOW_LABEL).not.toMatch(/plan/i)
    expect(DETAIL_WINDOW_LABEL).toMatch(/activities/i)
  })

  it('lists the settings that do not invalidate a plan', () => {
    expect(NON_INVALIDATING_SETTINGS.has('detailWindowDays')).toBe(true)
    expect(NON_INVALIDATING_SETTINGS.has('interests')).toBe(true)
    expect(NON_INVALIDATING_SETTINGS.has('endPoint')).toBe(false)
  })

  // Requested 2026-08-19: "I'd also like for adding an interest to not flag
  // the plan as stale." An interest steers what the next search looks for;
  // it is not something the existing days were built against.
  it('leaves a ready plan alone when an interest is added', async () => {
    updateDocMock.mockClear()
    await updateTripSettings('trip1', { interests: ['hiking', 'hot springs'] }, 'ready')

    const [, written] = updateDocMock.mock.calls[0]
    expect(written).toEqual({ 'settings.interests': ['hiking', 'hot springs'] })
    expect(written).not.toHaveProperty('planMeta.status')
  })
})

/**
 * Widened 2026-08-23: "I don't like that it goes 'stale' and needs full
 * generation. It should just grow organically."
 *
 * `stale` was never a broken plan — it has exactly two effects, the
 * Trip-setup button label and the date-shift gate, and nothing blocks on it.
 * So the question for each setting is not "could this matter?" but "does
 * this make the days already written WRONG?" For everything below, it does
 * not: it changes what the app should do next.
 */
describe('settings that no longer offer to rebuild the plan', () => {
  const nowAdvice: [string, Partial<Parameters<typeof updateTripSettings>[1]>][] = [
    ['a pacing preference', { maxDriveHoursPerDay: 4 }],
    ['how often to rest', { restDayFrequency: 5 }],
    ['which countries to favour', { preferredCountries: ['IT', 'AT'] }],
    ['who is coming', { travelers: [] }],
    ['how far off-grid to go', { offGridTolerance: 2 }],
  ]

  for (const [label, partial] of nowAdvice) {
    it(`leaves a ready plan alone when ${label} changes`, async () => {
      updateDocMock.mockClear()
      await updateTripSettings('trip1', partial, 'ready')

      const [, written] = updateDocMock.mock.calls[0]
      expect(written).not.toHaveProperty('planMeta.status')
      expect(written).not.toHaveProperty('planMeta.staleSettings')
    })
  }

  // The two that still do, and why: they change the ground the days were
  // built on rather than what to look for next.
  it('still marks stale when the trip’s dates move', async () => {
    updateDocMock.mockClear()
    await updateTripSettings('trip1', { startDate: '2026-07-17' }, 'ready')
    const [, written] = updateDocMock.mock.calls[0]
    expect(written).toMatchObject({ 'planMeta.status': 'stale' })
  })

  it('still marks stale when an endpoint moves', async () => {
    updateDocMock.mockClear()
    await updateTripSettings(
      'trip1',
      { endPoint: { name: 'Rome', lat: 41.9, lng: 12.5 } },
      'ready',
    )
    const [, written] = updateDocMock.mock.calls[0]
    expect(written).toMatchObject({ 'planMeta.status': 'stale' })
  })

  /**
   * The trap this design was checked against.
   *
   * `staleSettings` is written with arrayUnion, so it ACCUMULATES, and
   * detectDateShift only offers "Move the plan N days later" when every
   * entry is a date key. Had the drive-hours limit still been recorded
   * there, changing it and later changing the dates would leave
   * ['maxDriveHoursPerDay','startDate'] — no longer dates-only — and the
   * shortcut would have silently stopped appearing on exactly the trips
   * that had been fiddled with most.
   */
  it('does not pollute the date-shift reason list with advice-only settings', async () => {
    updateDocMock.mockClear()
    await updateTripSettings('trip1', { maxDriveHoursPerDay: 4 }, 'ready')
    await updateTripSettings('trip1', { startDate: '2026-07-17' }, 'ready')

    const [, first] = updateDocMock.mock.calls[0]
    const [, second] = updateDocMock.mock.calls[1]
    expect(first).not.toHaveProperty('planMeta.staleSettings')
    expect(second).toMatchObject({
      'planMeta.staleSettings': { arrayUnion: ['startDate'] },
    })
  })
})
