import { describe, expect, it } from 'vitest'
import { dayHeaderPhotos, type DayPhotoStop } from './dayHeaderPhoto'

const stop = (over: Partial<DayPhotoStop>): DayPhotoStop => ({
  id: over.id ?? 's1',
  name: over.name ?? 'Paganella Bike Dolomites',
  photoUrl: 'https://example.test/paganella.jpg',
  linkedDayIds: ['d1'],
  ...over,
})

/** Requested 2026-08-31: "carry the overview pic from planning in as a
 * header picture for day view." */
describe('dayHeaderPhoto', () => {
  it('takes the photo from a stop that claims this day', () => {
    expect(dayHeaderPhotos('d1', 'Molveno', [stop({})])).toEqual([
      {
        url: 'https://example.test/paganella.jpg',
        name: 'Paganella Bike Dolomites',
      },
    ])
  })

  it('ignores a stop that belongs to another day', () => {
    expect(
      dayHeaderPhotos('d2', 'Molveno', [stop({ linkedDayIds: ['d1'] })]),
    ).toEqual([])
  })

  it('has nothing to show when no stop carries a photo', () => {
    expect(
      dayHeaderPhotos('d1', 'Molveno', [stop({ photoUrl: undefined })]),
    ).toEqual([])
  })

  /**
   * A basecamp day can be claimed by several stops. The one the day is
   * built around is the one worth showing, and the overnight names it.
   */
  it('leads with the stop the day is built around', () => {
    const chosen = dayHeaderPhotos('d1', 'Lago di Molveno', [
      stop({ id: 'a', name: 'Andalo Cable Car' }),
      stop({
        id: 'b',
        name: 'Lago di Molveno',
        photoUrl: 'https://example.test/lago.jpg',
      }),
    ])
    // Both, in that order — requested 2026-08-31: "for days with several
    // activities, the header photo should be the activities next to one
    // another." A day built around a lake AND a cable car is two things.
    expect(chosen.map((photo) => photo.name)).toEqual([
      'Lago di Molveno',
      'Andalo Cable Car',
    ])
  })

  // Four across a phone is about 90px each; past that they stop being
  // recognisable as anything.
  it('stops at four, however many the day has', () => {
    const many = Array.from({ length: 7 }, (_, i) =>
      stop({
        id: `s${i}`,
        name: `Stop ${i}`,
        photoUrl: `https://example.test/${i}.jpg`,
      }),
    )
    expect(dayHeaderPhotos('d1', 'Nowhere', many)).toHaveLength(4)
  })

  // Firestore returns documents in no order the traveler can see, so without
  // this the same day could show a different picture on every load.
  it('picks the same one every time when nothing is built around', () => {
    const stops = [
      stop({ id: 'b', name: 'Zambana', photoUrl: 'https://example.test/z.jpg' }),
      stop({ id: 'a', name: 'Andalo', photoUrl: 'https://example.test/a.jpg' }),
    ]
    expect(dayHeaderPhotos('d1', 'Nowhere', stops)[0].name).toBe('Andalo')
    expect(
      dayHeaderPhotos('d1', 'Nowhere', [...stops].reverse())[0].name,
    ).toBe('Andalo')
  })
})

// Places and Claude disagree about diacritics, so "Molveno" arriving as
// "Molvenò" must still be recognised as the place the day is built around.
it('matches a name across the diacritics the sources disagree about', () => {
  const chosen = dayHeaderPhotos('d1', 'Andalo–Molveno', [
    { id: 'a', name: 'Zzz', photoUrl: 'https://example.test/z.jpg', linkedDayIds: ['d1'] },
    {
      id: 'b',
      name: 'Àndalo Molvenò',
      photoUrl: 'https://example.test/m.jpg',
      linkedDayIds: ['d1'],
    },
  ])
  expect(chosen[0].name).toBe('Àndalo Molvenò')
})
