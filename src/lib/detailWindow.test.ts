import { describe, expect, it, vi } from 'vitest'
import { describeDetailWindow, NON_INVALIDATING_SETTINGS } from './detailWindow'

const updateDocMock = vi.fn().mockResolvedValue(undefined)
vi.mock('firebase/firestore', () => ({
  doc: (_db: unknown, ..._path: string[]) => ({ id: _path[_path.length - 1] }),
  updateDoc: (ref: { id: string }, data: unknown) => updateDocMock(ref.id, data),
}))
vi.mock('./firebase', () => ({ db: {} }))

const { updateTripSettings } = await import('./updateTripSettings')

// The sentence under the slider. Its job is to stop "Plan ahead: 3 days"
// reading as "only 3 days of this trip are planned" — the route and the
// overnight stops are settled end to end whatever this is set to.
describe('describeDetailWindow', () => {
  it('says the whole trip is still routed', () => {
    expect(describeDetailWindow(3)).toMatch(/whole trip/i)
  })

  it('names the number of days it was given', () => {
    expect(describeDetailWindow(5)).toContain('first 5 days')
  })

  it('reads correctly at one day', () => {
    expect(describeDetailWindow(1)).toContain('Only the first day')
    expect(describeDetailWindow(1)).not.toContain('1 days')
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
    await updateTripSettings('trip1', { maxDriveHoursPerDay: 4 }, 'ready')

    const [, written] = updateDocMock.mock.calls[0]
    expect(written).toMatchObject({ 'planMeta.status': 'stale' })
  })

  // A single edit carrying both is an edit that invalidates.
  it('marks stale when an invalidating setting rides along with the window', async () => {
    updateDocMock.mockClear()
    await updateTripSettings(
      'trip1',
      { detailWindowDays: 7, maxDriveHoursPerDay: 4 },
      'ready',
    )

    const [, written] = updateDocMock.mock.calls[0]
    expect(written).toMatchObject({ 'planMeta.status': 'stale' })
  })

  // The existing rule, unchanged: only a ready plan has anything to lose.
  it('never marks a trip that has no plan yet', async () => {
    updateDocMock.mockClear()
    await updateTripSettings('trip1', { maxDriveHoursPerDay: 4 }, 'idle')

    const [, written] = updateDocMock.mock.calls[0]
    expect(written).not.toHaveProperty('planMeta.status')
  })

  it('lists the detail window as the non-invalidating setting', () => {
    expect(NON_INVALIDATING_SETTINGS.has('detailWindowDays')).toBe(true)
    expect(NON_INVALIDATING_SETTINGS.has('endPoint')).toBe(false)
  })
})
