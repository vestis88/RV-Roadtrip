import { describe, expect, it, vi } from 'vitest'

const addDocMock = vi.fn().mockResolvedValue({ id: 'new1' })
vi.mock('firebase/firestore', () => ({
  collection: (_db: unknown, ...path: string[]) => ({ path: path.join('/') }),
  addDoc: (ref: { path: string }, data: unknown) => addDocMock(ref.path, data),
}))
vi.mock('./firebase', () => ({ db: {} }))

const { addFindToTrip } = await import('./addFind')

const FIND = {
  name: 'Cascate di Barbiano',
  lat: 46.6,
  lng: 11.5,
  country: 'IT',
  why: 'A waterfall hike through a narrow gorge.',
}

/**
 * Reported 2026-08-25: "results added to the map are not possible to
 * interact with, even though they have been added to the trip. At restart,
 * the added results are gone."
 */
describe('adding a search find to the trip', () => {
  it('writes it as an ordinary candidate the board can act on', async () => {
    addDocMock.mockClear()
    await addFindToTrip('trip1', FIND)

    const [path, written] = addDocMock.mock.calls[0]
    expect(path).toBe('trips/trip1/corridorStops')
    // Every field the board needs to render a card and a pin for it.
    expect(written).toMatchObject({
      name: 'Cascate di Barbiano',
      lat: 46.6,
      lng: 11.5,
      country: 'IT',
      status: 'candidate',
      linkedDayIds: [],
      origin: 'traveler',
    })
  })

  it('carries the photo and the listing link when the find has them', async () => {
    addDocMock.mockClear()
    await addFindToTrip('trip1', {
      ...FIND,
      photoUrl: 'https://example.test/p.jpg',
      googleMapsUrl: 'https://maps.example.test/x',
    })
    const [, written] = addDocMock.mock.calls[0]
    expect(written.photoUrl).toBe('https://example.test/p.jpg')
    expect(written.googleMapsUrl).toBe('https://maps.example.test/x')
  })

  /**
   * Firestore rejects an `undefined` field value outright, so a find with no
   * photo would otherwise throw and take the whole add with it — which is
   * exactly the shape of "it said Added and then it was gone".
   */
  it('omits absent optional fields rather than writing undefined', async () => {
    addDocMock.mockClear()
    await addFindToTrip('trip1', FIND)
    const [, written] = addDocMock.mock.calls[0]
    expect(written).not.toHaveProperty('photoUrl')
    expect(written).not.toHaveProperty('googleMapsUrl')
    for (const value of Object.values(written)) {
      expect(value).not.toBeUndefined()
    }
  })

  // A stop with no country cannot become an overnight — the schema wants two
  // letters — and a malformed one surfaces a long way from here.
  it('never writes an undefined country', async () => {
    addDocMock.mockClear()
    await addFindToTrip('trip1', {
      ...FIND,
      country: undefined as unknown as string,
    })
    const [, written] = addDocMock.mock.calls[0]
    expect(written.country).toBe('XX')
  })

  it('propagates a failure rather than reporting success', async () => {
    addDocMock.mockRejectedValueOnce(new Error('permission-denied'))
    await expect(addFindToTrip('trip1', FIND)).rejects.toThrow()
  })
})
