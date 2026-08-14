import { describe, expect, it } from 'vitest'
import { __testing } from './placesApi.js'

const {
  nameLooksRight,
  nameMatchScore,
  nameTokens,
  bestCandidate,
  bestFromLadder,
  PLACE_VERIFY_BAR,
  RESTAURANT_VERIFY_BAR,
  PLACE_QUALITY_LADDER,
  RESTAURANT_QUALITY_LADDER,
} = __testing

const NEAR = { lat: 55.7, lng: 12.6 }

let id = 0
function candidate(
  name: string,
  rating: number | undefined,
  ratingCount: number | undefined,
) {
  id += 1
  return { id: `p${id}`, name, lat: NEAR.lat, lng: NEAR.lng, rating, ratingCount }
}

describe('nameTokens', () => {
  it('folds case, diacritics and punctuation', () => {
    expect(nameTokens('Møns Klint!')).toEqual(['mons', 'klint'])
    expect(nameTokens('CAFÉ  Sletten')).toEqual(['sletten'])
  })

  it('drops generic nouns that would match anything of that kind', () => {
    expect(nameTokens('Restaurant Sletten')).toEqual(['sletten'])
    expect(nameTokens('Hotel Bella Vista')).toEqual(['bella', 'vista'])
  })
})

describe('nameLooksRight', () => {
  it('accepts a fuller listing name for the same place', () => {
    expect(nameLooksRight('Kronborg', 'Kronborg Castle')).toBe(true)
    expect(nameLooksRight('Møns Klint', 'Mons Klint Cliffs')).toBe(true)
  })

  it('accepts a shorter listing name for the same place', () => {
    expect(nameLooksRight('Restaurant Sletten', 'Sletten')).toBe(true)
  })

  // The Berlin case: a famous landmark answering for a small cafe. Distance
  // never catches this one — the outlet is well inside the radius.
  it('rejects an unrelated landmark that merely shares the town', () => {
    expect(nameLooksRight('Café Anna Blume', 'Designer Outlet Berlin')).toBe(
      false,
    )
  })

  it('rejects a partial overlap that misses most of the name', () => {
    expect(nameLooksRight('Bella Vista Village', 'Village Green Diner')).toBe(
      false,
    )
  })

  // Backfill asks for a category, not a place — anything of that kind is a
  // correct answer, so there is nothing to check against.
  it('passes anything through when no name was requested', () => {
    expect(nameLooksRight(undefined, 'Designer Outlet Berlin')).toBe(true)
  })

  it('passes through when the request is entirely generic words', () => {
    expect(nameLooksRight('The Restaurant', 'Designer Outlet Berlin')).toBe(true)
  })
})

// Regression: ø/æ/ß are letters, not decomposable accents, so NFD leaves
// them and the ASCII strip would delete them outright — "Møns" became "ns"
// and stopped matching Places' own "Mons Klint". Scandinavian names are the
// common case for this app, not an edge case.
describe('nameTokens on non-decomposing letters', () => {
  it('transliterates Nordic letters rather than deleting them', () => {
    expect(nameTokens('Møns Klint')).toEqual(['mons', 'klint'])
    expect(nameTokens('Ærø')).toEqual(['aero'])
    expect(nameTokens('Strauß')).toEqual(['strauss'])
  })

  it('still folds the accents that do decompose', () => {
    expect(nameTokens('Åre Skidort')).toEqual(['are', 'skidort'])
    expect(nameTokens('Zürich')).toEqual(['zurich'])
  })

  it('matches a Danish name against its de-accented Places listing', () => {
    expect(nameLooksRight('Møns Klint', 'Mons Klint')).toBe(true)
  })
})

describe('nameMatchScore', () => {
  it('scores an exact match above a partial one', () => {
    expect(nameMatchScore('Restaurant Sletten', 'Sletten')).toBe(1)
    expect(nameMatchScore('Bella Vista Grill', 'Bella Vista')).toBeCloseTo(2 / 3)
    expect(nameMatchScore('Bella Vista Grill', 'Bella Vista Grill')).toBe(1)
  })

  it('scores everything alike when no name was asked for', () => {
    expect(nameMatchScore(undefined, 'Designer Outlet Berlin')).toBe(1)
    expect(nameMatchScore(undefined, 'Café Anna Blume')).toBe(1)
  })
})

/**
 * The selection half of the BIG Shopping fix. Places orders its own results
 * by prominence, and every path here used to take the first one clearing the
 * bar — which is how a 3.8-star shopping centre with 9,125 reviews was
 * served as lunch.
 */
describe('bestCandidate', () => {
  it('takes the best-rated place, not the one Places listed first', () => {
    const mall = candidate('BIG Shopping', 4.0, 9125)
    const kitchen = candidate('Munkebo Køkken', 4.6, 320)
    expect(
      bestCandidate([mall, kitchen], NEAR, undefined, new Set(), PLACE_VERIFY_BAR)
        ?.name,
    ).toBe('Munkebo Køkken')
  })

  it('ignores a perfect rating that nobody has voted on', () => {
    const noise = candidate('Brand New Bistro', 5.0, 6)
    const solid = candidate('Spisehuset', 4.4, 300)
    expect(
      bestCandidate([noise, solid], NEAR, undefined, new Set(), PLACE_VERIFY_BAR)
        ?.name,
    ).toBe('Spisehuset')
  })

  it('breaks a tie on rating with the more-reviewed of the two', () => {
    const few = candidate('Kro A', 4.5, 60)
    const many = candidate('Kro B', 4.5, 900)
    expect(
      bestCandidate([few, many], NEAR, undefined, new Set(), PLACE_VERIFY_BAR)?.name,
    ).toBe('Kro B')
  })

  /**
   * Identity beats quality when a name was asked for: a better-rated
   * near-namesake is still the wrong place, and swapping it in is the same
   * bug as the Greek hotel and the Berlin outlet in a subtler costume.
   */
  it('prefers the place that was actually named over a better-rated namesake', () => {
    const asked = candidate('Sletten', 4.2, 300)
    const namesake = candidate('Sletten Bageri og Konditori', 4.9, 400)
    expect(
      bestCandidate(
        [namesake, asked],
        NEAR,
        'Restaurant Sletten',
        new Set(),
        PLACE_VERIFY_BAR,
      )?.name,
    ).toBe('Sletten')
  })

  it('holds restaurants to a higher floor than sights', () => {
    const pool = [candidate('Grillbaren', 3.9, 500)]
    expect(
      bestCandidate(pool, NEAR, undefined, new Set(), PLACE_VERIFY_BAR),
    ).toBeDefined()
    expect(
      bestCandidate(pool, NEAR, undefined, new Set(), RESTAURANT_VERIFY_BAR),
    ).toBeUndefined()
  })

  it('never returns a place already taken by another slot', () => {
    const taken = candidate('Spisehuset', 4.8, 400)
    const other = candidate('Kroen', 4.2, 200)
    expect(
      bestCandidate(
        [taken, other],
        NEAR,
        undefined,
        new Set([taken.id]),
        PLACE_VERIFY_BAR,
      )?.name,
    ).toBe('Kroen')
  })
})

describe('bestFromLadder', () => {
  it('stops at the top rung when the town has genuinely top-rated places', () => {
    const top = candidate('Fjordrestauranten', 4.4, 400)
    const relaxed = candidate('Hyttekroen', 4.9, 15)
    expect(
      bestFromLadder([relaxed, top], NEAR, new Set(), RESTAURANT_QUALITY_LADDER)?.name,
    ).toBe('Fjordrestauranten')
  })

  it('relaxes the review count rather than coming back empty-handed', () => {
    const okay = candidate('Vejkroen', 4.05, 40)
    const loved = candidate('Fjordhytten', 4.2, 12)
    expect(
      bestFromLadder([okay, loved], NEAR, new Set(), RESTAURANT_QUALITY_LADDER)?.name,
    ).toBe('Fjordhytten')
  })

  it('still refuses to fill a slot with a badly-rated place', () => {
    expect(
      bestFromLadder(
        [candidate('Pølsevognen', 3.9, 800)],
        NEAR,
        new Set(),
        RESTAURANT_QUALITY_LADDER,
      ),
    ).toBeUndefined()
    // The same rating would be an acceptable sight — the restaurant floor is
    // the stricter one on purpose (see MIN_RESTAURANT_RATING).
    expect(
      bestFromLadder(
        [candidate('Udsigtspunktet', 3.9, 800)],
        NEAR,
        new Set(),
        PLACE_QUALITY_LADDER,
      ),
    ).toBeDefined()
  })
})
