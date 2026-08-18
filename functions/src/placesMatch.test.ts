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

/**
 * Reported 2026-08-17 with a screenshot: a card headed "Bruzaholms Gokart" —
 * Google's own listing calls it a Gokartbana — carrying a description of a
 * lift-free downhill and enduro trail network, under the interest "mountain
 * biking". Curation had proposed a mountain-bike spot in Bruzaholm; Places
 * answered with the best-known business in that village sharing its name,
 * and the name check said yes.
 */
describe('nameLooksRight — a place of a different KIND is a different place', () => {
  it('rejects the go-kart track that stood in for a bike park', () => {
    expect(nameLooksRight('Bruzaholms MTB', 'Bruzaholms Gokart')).toBe(false)
    expect(nameLooksRight('Bruzaholms Bike Park', 'Bruzaholms Gokart')).toBe(
      false,
    )
    expect(nameLooksRight('Bruzaholms cykelpark', 'Bruzaholms Gokartbana')).toBe(
      false,
    )
  })

  // The arithmetic that let it through: half the words, floor of one, so a
  // two-word "place + category" name needed only the place.
  it('no longer lets the place name alone carry a two-word request', () => {
    expect(nameLooksRight('Åre Bike Park', 'Åre Skidområde')).toBe(false)
    expect(nameLooksRight('Kolmårdens Djurpark', 'Kolmårdens Camping')).toBe(
      false,
    )
  })

  // Both halves matter: silence is not disagreement. A result that names no
  // category contradicts nothing.
  it('does not reject a result that simply does not say what it is', () => {
    expect(nameLooksRight('Møns Klint', 'Møns Klint')).toBe(true)
    expect(nameLooksRight('Kronborg', 'Kronborg Castle')).toBe(true)
  })

  // And the case no string rule can separate from the go-kart one without
  // knowing that these two words mean the same thing.
  it('still matches a category translated into another language', () => {
    expect(nameLooksRight('Kronborg Slot', 'Kronborg Castle')).toBe(true)
    expect(nameLooksRight('Frederiksborg Castle', 'Frederiksborg Slot')).toBe(
      true,
    )
    expect(nameLooksRight('Lunds Domkyrka', 'Lund Cathedral')).toBe(true)
  })

  // Scandinavian names compound, so the category is routinely inside a word
  // rather than beside it.
  it('reads the category out of a compound word', () => {
    expect(nameLooksRight('Järvsö Bergscykelpark', 'Järvsö Gokartbana')).toBe(
      false,
    )
    expect(nameLooksRight('Järvsö Bergscykelpark', 'Järvsö Bike Park')).toBe(
      true,
    )
  })

  // A category search asks for a kind of place, not a named one — every
  // result is a correct answer and this check must stay out of the way.
  it('leaves the category backfill paths alone', () => {
    expect(nameLooksRight(undefined, 'Bruzaholms Gokart')).toBe(true)
    expect(nameLooksRight('The Restaurant', 'Bruzaholms Gokart')).toBe(true)
  })
})

// Found while fixing the above: Nordic names take a genitive -s that Places'
// own listing routinely drops or adds, and the place name is the one word a
// match cannot afford to lose. This direction only ever loosens — it recovers
// candidates that were being dropped, it does not admit a different kind of
// place, which the category check still refuses.
describe('nameLooksRight — the Nordic genitive -s', () => {
  it('matches a name across the genitive', () => {
    expect(nameLooksRight('Lunds Domkyrka', 'Lund Cathedral')).toBe(true)
    expect(nameLooksRight('Kolmårdens Djurpark', 'Kolmården Zoo')).toBe(true)
  })

  it('does not let it reunite two different kinds of place', () => {
    expect(nameLooksRight('Kolmårdens Djurpark', 'Kolmården Camping')).toBe(
      false,
    )
  })

  // Only a trailing -s on a word long enough for it to be a suffix rather
  // than the word.
  it('leaves short words alone', () => {
    expect(nameTokens('Aas')).toEqual(['aas'])
    expect(nameLooksRight('Aas Gaard', 'Aa Gaard')).toBe(false)
  })
})

// Reported 2026-08-18: "The descriptions for activities seems to have become
// quite generic." They were substitutes — a proposal that fails verification
// is not shown as a gap, it is replaced by the best-rated thing of its kind
// nearby, carrying a template blurb and a "Top-rated nearby" chip. The
// all-but-one threshold added the day before went with the two-word fix for
// symmetry rather than because any failure asked for it, and it was pushing
// legitimate suggestions into that fallback.
describe('nameLooksRight — strict enough to catch the wrong place, no stricter', () => {
  // The case the tightening was actually for. Unchanged.
  it('still refuses a two-word name matched on its place name alone', () => {
    expect(nameLooksRight('Bruzaholms MTB', 'Bruzaholms Gokart')).toBe(false)
    expect(nameLooksRight('Åre Bike Park', 'Åre Skidområde')).toBe(false)
  })

  // Longer names are back to half, which is what they were before
  // 2026-08-17. Five identifying words needed four yesterday and need three
  // now, which is the difference between Places' shorter listing name being
  // accepted and the slot falling through to a substitute.
  it('accepts a longer name that Places lists more briefly', () => {
    expect(
      nameLooksRight('Wadden Sea National Park Visitor Centre', 'Wadden Sea Centre'),
    ).toBe(true)
  })

  // A known limitation, asserted so it is recorded rather than assumed away:
  // a category translated into a COMPOUND ("Nature Reserve" against German
  // "Naturschutzgebiet") is still not matched. CATEGORY_GROUPS handles the
  // cases where the category is its own word; teaching it compound
  // translations is a bigger job than this fix, and getting it wrong reopens
  // the go-kart hole. Loosening the count would not fix this either — the
  // place name is one hit out of three.
  it('does not yet match a category translated into a compound', () => {
    expect(
      nameLooksRight('Schellbruch Nature Reserve', 'Naturschutzgebiet Schellbruch'),
    ).toBe(false)
  })

  // And the guard that actually caught the go-kart track is untouched, so
  // loosening the count cannot reopen it.
  it('keeps rejecting a different kind of place however long the name', () => {
    expect(
      nameLooksRight('Lübeck Bike Park Trails', 'Lübeck Golfklubb Anlage'),
    ).toBe(false)
  })
})
