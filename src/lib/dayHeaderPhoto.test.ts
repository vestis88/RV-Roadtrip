import { describe, expect, it } from 'vitest'
import { dayHeaderPhoto, type DayPhotoStop } from './dayHeaderPhoto'

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
    expect(dayHeaderPhoto('d1', 'Molveno', [stop({})])).toEqual({
      url: 'https://example.test/paganella.jpg',
      name: 'Paganella Bike Dolomites',
    })
  })

  it('ignores a stop that belongs to another day', () => {
    expect(
      dayHeaderPhoto('d2', 'Molveno', [stop({ linkedDayIds: ['d1'] })]),
    ).toBeUndefined()
  })

  it('has nothing to show when no stop carries a photo', () => {
    expect(
      dayHeaderPhoto('d1', 'Molveno', [stop({ photoUrl: undefined })]),
    ).toBeUndefined()
  })

  /**
   * A basecamp day can be claimed by several stops. The one the day is
   * built around is the one worth showing, and the overnight names it.
   */
  it('prefers the stop the day is built around', () => {
    const chosen = dayHeaderPhoto('d1', 'Lago di Molveno', [
      stop({ id: 'a', name: 'Andalo Cable Car' }),
      stop({
        id: 'b',
        name: 'Lago di Molveno',
        photoUrl: 'https://example.test/lago.jpg',
      }),
    ])
    expect(chosen?.name).toBe('Lago di Molveno')
  })

  // Firestore returns documents in no order the traveler can see, so without
  // this the same day could show a different picture on every load.
  it('picks the same one every time when nothing is built around', () => {
    const stops = [
      stop({ id: 'b', name: 'Zambana', photoUrl: 'https://example.test/z.jpg' }),
      stop({ id: 'a', name: 'Andalo', photoUrl: 'https://example.test/a.jpg' }),
    ]
    expect(dayHeaderPhoto('d1', 'Nowhere', stops)?.name).toBe('Andalo')
    expect(dayHeaderPhoto('d1', 'Nowhere', [...stops].reverse())?.name).toBe(
      'Andalo',
    )
  })
})

// Places and Claude disagree about diacritics, so "Molveno" arriving as
// "Molvenò" must still be recognised as the place the day is built around.
it('matches a name across the diacritics the sources disagree about', () => {
  const chosen = dayHeaderPhoto('d1', 'Andalo–Molveno', [
    { id: 'a', name: 'Zzz', photoUrl: 'https://example.test/z.jpg', linkedDayIds: ['d1'] },
    {
      id: 'b',
      name: 'Àndalo Molvenò',
      photoUrl: 'https://example.test/m.jpg',
      linkedDayIds: ['d1'],
    },
  ])
  expect(chosen?.name).toBe('Àndalo Molvenò')
})
