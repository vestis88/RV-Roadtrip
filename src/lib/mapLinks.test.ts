import { describe, expect, it } from 'vitest'
import { navigateUrl, placeDetailsUrl } from './mapLinks'

const LISTING = 'https://maps.google.com/?cid=12345'

describe('placeDetailsUrl', () => {
  it("uses Google's own listing URL when the stop has one", () => {
    expect(
      placeDetailsUrl({
        googleMapsUrl: LISTING,
        name: 'Klässbols Linneväveri',
        lat: 59.5315622,
        lng: 12.7446268,
      }),
    ).toBe(LISTING)
  })

  // The reported bug: this link promises photos and details, and a bare
  // coordinate opens a nameless pin in a field that has neither. Every stop
  // already in Firestore predates the listing URL being stored, so the name
  // query is what fixes those without a re-curation.
  it('falls back to a name query, not coordinates, for a stop stored before listing URLs', () => {
    const url = placeDetailsUrl({
      name: 'Klässbols Linneväveri',
      baseTown: 'Klässbol',
      country: 'SE',
      lat: 59.5315622,
      lng: 12.7446268,
    })

    expect(url).toContain('query=')
    expect(decodeURIComponent(url)).toContain('Klässbols Linneväveri, Klässbol, SE')
    expect(url).not.toContain('59.5315622')
  })

  // The town and country are what stop a common name matching a namesake in
  // another country — the same class of failure as the Greek hotel.
  it('keeps the place context in the query even when only the country is known', () => {
    const url = placeDetailsUrl({
      name: 'Storkyrkan',
      country: 'SE',
      lat: 59.3,
      lng: 18.07,
    })
    expect(decodeURIComponent(url)).toContain('Storkyrkan, SE')
  })

  it('falls back to coordinates when there is no name to ask for', () => {
    expect(placeDetailsUrl({ lat: 59.5, lng: 12.7 })).toContain('query=59.5,12.7')
  })
})

describe('navigateUrl', () => {
  it('opens the listing for a campsite that came from Places', () => {
    expect(navigateUrl({ googleMapsUrl: LISTING, lat: 59.5, lng: 12.7 })).toBe(
      LISTING,
    )
  })

  // Deliberately NOT a name query. A stellplatz or a free spot IS the
  // coordinate: its name is the town it sits near, and resolving that would
  // route the RV to the town square instead of the pull-in.
  it('keeps the exact coordinate for a stop with no listing', () => {
    expect(navigateUrl({ lat: 59.5315622, lng: 12.7446268 })).toContain(
      'query=59.5315622,12.7446268',
    )
  })
})
