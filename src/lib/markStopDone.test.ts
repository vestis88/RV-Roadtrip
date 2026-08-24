import { describe, expect, it, vi } from 'vitest'

const updateDocMock = vi.fn().mockResolvedValue(undefined)
const addDocMock = vi.fn().mockResolvedValue({ id: 'log1' })
vi.mock('firebase/firestore', () => ({
  doc: (_db: unknown, ...path: string[]) => ({ path: path.join('/') }),
  collection: (_db: unknown, ...path: string[]) => ({ path: path.join('/') }),
  updateDoc: (ref: { path: string }, data: unknown) =>
    updateDocMock(ref.path, data),
  addDoc: (ref: { path: string }, data: unknown) => addDocMock(ref.path, data),
  getDocs: vi.fn(),
  deleteField: () => ({ __deleted: true }),
}))
vi.mock('firebase/functions', () => ({ httpsCallable: () => vi.fn() }))
vi.mock('./firebase', () => ({ db: {}, functions: {} }))

const { markStopDone, unmarkStopDone } = await import('./placeStatus')

/**
 * Requested 2026-08-23: "When marking things done, they are moved to the
 * diary. This is when they should get a date time stamp (defaulting to 'now'
 * but possible to change if we are lazy with marking done)."
 */
describe('marking a corridor stop done', () => {
  it('stamps the stop and writes a diary entry for it', async () => {
    updateDocMock.mockClear()
    addDocMock.mockClear()
    await markStopDone('trip1', 'stopA', new Date('2026-08-20T09:30:00.000Z'))

    const [stopPath, written] = updateDocMock.mock.calls[0]
    expect(stopPath).toBe('trips/trip1/corridorStops/stopA')
    expect(written).toEqual({ doneAt: '2026-08-20T09:30:00.000Z' })

    const [logPath, entry] = addDocMock.mock.calls[0]
    expect(logPath).toBe('trips/trip1/log')
    // The diary groups by day, and the day is the traveler's answer.
    expect(entry).toMatchObject({
      date: '2026-08-20',
      refType: 'stop',
      refPath: 'trips/trip1/corridorStops/stopA',
    })
  })

  /**
   * The "if we are lazy" half. The moment is the traveler's; `createdAt`
   * stays the immutable record of when it was typed, so a stop marked done
   * three days late lands in the diary on the day it actually happened.
   */
  it('keeps when it happened separate from when it was typed', async () => {
    addDocMock.mockClear()
    await markStopDone('trip1', 'stopA', new Date('2026-08-18T12:00:00.000Z'))

    const [, entry] = addDocMock.mock.calls[0]
    expect(entry.date).toBe('2026-08-18')
    expect(entry.createdAt).not.toBe('2026-08-18T12:00:00.000Z')
  })

  it('defaults to now when nobody says otherwise', async () => {
    updateDocMock.mockClear()
    const before = Date.now()
    await markStopDone('trip1', 'stopA')
    const [, written] = updateDocMock.mock.calls[0]
    expect(new Date(written.doneAt).getTime()).toBeGreaterThanOrEqual(before)
  })

  /**
   * The diary groups by `date`, and `date` must be the traveler's calendar
   * day rather than the UTC one. This was written as `doneAt.slice(0, 10)`,
   * which files a 23:30 stop under tomorrow west of Greenwich and a 00:30 one
   * under yesterday east of it.
   *
   * Both ends are asserted because only one of them can fail in any given
   * zone — and in a UTC runner neither does, which is correct: in UTC there
   * is no discrepancy to have.
   */
  it('files the entry under the local calendar day, not the UTC one', async () => {
    for (const [hour, minute] of [
      [23, 30],
      [0, 30],
    ]) {
      addDocMock.mockClear()
      const when = new Date(2026, 7, 20, hour, minute)
      await markStopDone('trip1', 'stopA', when)
      const [, entry] = addDocMock.mock.calls[0]
      expect(entry.date).toBe('2026-08-20')
    }
  })

  it('records the note the traveler typed', async () => {
    addDocMock.mockClear()
    await markStopDone('trip1', 'stopA', new Date(), 'Rained the whole time.')
    const [, entry] = addDocMock.mock.calls[0]
    expect(entry.note).toBe('Rained the whole time.')
  })

  // An absent note must stay absent rather than becoming an empty string —
  // DiaryScreen renders the note block on truthiness.
  it('omits the note entirely when there is none', async () => {
    addDocMock.mockClear()
    await markStopDone('trip1', 'stopA')
    const [, entry] = addDocMock.mock.calls[0]
    expect(entry).not.toHaveProperty('note')
  })

  // One tap, and it will be mistapped. Deleting the field rather than
  // writing a falsy one keeps "absent means not done" the only rule.
  it('undoes by removing the field entirely', async () => {
    updateDocMock.mockClear()
    await unmarkStopDone('trip1', 'stopA')
    const [path, written] = updateDocMock.mock.calls[0]
    expect(path).toBe('trips/trip1/corridorStops/stopA')
    expect(written.doneAt).toEqual({ __deleted: true })
  })
})
