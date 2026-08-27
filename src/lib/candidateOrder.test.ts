import { describe, expect, it } from 'vitest'
import { orderCandidatesByRoute, orderStopsFromHere } from './candidateOrder'
import type { CorridorStopWithId } from '../hooks/useCorridorStops'

function stop(
  id: string,
  lat: number,
  lng: number,
  over: Partial<CorridorStopWithId> = {},
): CorridorStopWithId {
  return {
    id,
    name: id,
    lat,
    lng,
    country: 'DE',
    status: 'locked',
    linkedDayIds: [],
    ...over,
  } as CorridorStopWithId
}

const MUNICH = { lat: 48.14, lng: 11.58 }
const VENICE = { lat: 45.44, lng: 12.32 }

/**
 * Reported 2026-08-24: "The list is not updating according to the logical
 * chronological order, not even when locked in."
 */
describe('ordering the candidate list', () => {
  it('puts kept stops in the order they are driven', () => {
    // Deliberately supplied backwards: the route is the authority, not the
    // order the snapshot happened to arrive in.
    const a = stop('a', 47.5, 11.0)
    const b = stop('b', 46.5, 11.5)
    const ordered = orderCandidatesByRoute({
      candidates: [b, a],
      routeStops: [a, b],
      backbone: [MUNICH, a, b, VENICE],
    })
    expect(ordered.map((s) => s.id)).toEqual(['a', 'b'])
  })

  /**
   * The whole bug, in the one shape that proves it.
   *
   * An out-and-back: south to Verona, then back north to Innsbruck before
   * running down to Venice. The straight-line projection sorts by distance
   * along Munich→Venice, so it puts Innsbruck first — it is far nearer
   * Munich — and no amount of locking in changes its mind, which is exactly
   * what was reported.
   *
   * Written this way deliberately. Three other orderings I tried first came
   * out identical under the old projection, so they proved nothing about the
   * fix; a test that passes before and after is not evidence.
   */
  it('follows a route that doubles back, which the projection cannot', () => {
    const south = stop('verona', 45.44, 10.99)
    const backNorth = stop('innsbruck', 47.27, 11.4)
    const ordered = orderCandidatesByRoute({
      candidates: [backNorth, south],
      routeStops: [south, backNorth],
      backbone: [MUNICH, south, backNorth, VENICE],
    })
    expect(ordered.map((s) => s.id)).toEqual(['verona', 'innsbruck'])
  })

  it('honours a manual reorder, since that is what routeStops carries', () => {
    const a = stop('a', 47.5, 11.0)
    const b = stop('b', 46.5, 11.5)
    const ordered = orderCandidatesByRoute({
      candidates: [a, b],
      routeStops: [b, a],
      backbone: [MUNICH, b, a, VENICE],
    })
    expect(ordered.map((s) => s.id)).toEqual(['b', 'a'])
  })

  /**
   * An unkept candidate has no place in the route, so it takes the place it
   * WOULD have — between the two stops it is cheapest to insert between.
   * Same function as the "≈+41 km" badge, so the two cannot disagree about
   * which leg a stop belongs to.
   */
  it('slots an unkept candidate between the stops it would sit between', () => {
    const first = stop('first', 47.5, 11.0)
    const last = stop('last', 46.0, 11.5)
    const between = stop('between', 46.8, 11.2, { status: 'candidate' })
    const ordered = orderCandidatesByRoute({
      candidates: [between, first, last],
      routeStops: [first, last],
      backbone: [MUNICH, first, last, VENICE],
    })
    expect(ordered.map((s) => s.id)).toEqual(['first', 'between', 'last'])
  })

  // Several unkept candidates routinely share a leg; a list that reshuffled
  // them on every snapshot would be unusable.
  it('is stable for candidates that share a leg', () => {
    const kept = stop('kept', 47.5, 11.0)
    const x = stop('x', 46.80, 11.20, { status: 'candidate' })
    const y = stop('y', 46.81, 11.21, { status: 'candidate' })
    const args = {
      routeStops: [kept],
      backbone: [MUNICH, kept, VENICE],
    }
    expect(
      orderCandidatesByRoute({ candidates: [x, y], ...args }).map((s) => s.id),
    ).toEqual(['x', 'y'])
    // Same inputs, same answer — twice.
    expect(
      orderCandidatesByRoute({ candidates: [x, y], ...args }).map((s) => s.id),
    ).toEqual(['x', 'y'])
  })

  /**
   * No route means no route order, and inventing one would be the mistake
   * this replaces. The straight-line projection is at least a stable reading
   * of a corridor nobody has committed to.
   */
  it('falls back to the corridor projection before anything is kept', () => {
    const near = stop('near', 47.9, 11.6, { status: 'candidate' })
    const far = stop('far', 46.0, 12.0, { status: 'candidate' })
    const ordered = orderCandidatesByRoute({
      candidates: [far, near],
      routeStops: [],
      backbone: [],
      startPoint: MUNICH,
      endPoint: VENICE,
    })
    expect(ordered.map((s) => s.id)).toEqual(['near', 'far'])
  })
})

/**
 * Reported 2026-08-26 from the Seiser Alm: "it's jumping around, for some
 * reason putting Kronplatz ahead of Seiser Alm, even though we are at Seiser
 * Alm."
 *
 * The order is worked out from the traveler's own position now — "just treat
 * that as the current starting point" — and the guess that feeds it is
 * projected from there too. These assert the geometry that makes that come
 * out right, against the real coordinates from the report.
 */
describe('ordering from where the van actually is', () => {
  const SEISER_ALM = { lat: 46.53, lng: 11.6 }
  const KRONPLATZ = { lat: 46.74, lng: 11.95 }
  const VERONA = { lat: 45.44, lng: 10.99 }

  it('puts the stop you are standing at first', () => {
    const seiser = stop('seiser', SEISER_ALM.lat, SEISER_ALM.lng)
    const kronplatz = stop('kronplatz', KRONPLATZ.lat, KRONPLATZ.lng)
    // The route as it is drawn: from here, through both, to the end point.
    const ordered = orderCandidatesByRoute({
      candidates: [kronplatz, seiser],
      routeStops: [seiser, kronplatz],
      backbone: [SEISER_ALM, seiser, kronplatz, VERONA],
    })
    expect(ordered.map((s) => s.id)).toEqual(['seiser', 'kronplatz'])
  })

  /**
   * And the guess that feeds it. Moving the anchor to the van was NOT enough
   * on its own, which is what writing this test showed: `sortAlongRoute`
   * sorts by scalar projection, and Kronplatz — north-east while the route
   * runs south-west to Verona — projects NEGATIVE from the Seiser Alm and so
   * sorted first anyway. A stop behind you is still yours; it is just not
   * next.
   */
  it('puts what is ahead before what is behind', () => {
    const seiser = { id: 'seiser', ...SEISER_ALM }
    const kronplatz = { id: 'kronplatz', ...KRONPLATZ }
    const verona = { id: 'verona', ...VERONA }

    const ordered = orderStopsFromHere(
      SEISER_ALM,
      VERONA,
      [kronplatz, seiser, verona],
      (s) => s,
    )
    expect(ordered.map((s) => s.id)).toEqual(['seiser', 'verona', 'kronplatz'])
  })

  // The plain projection is what got it wrong, and saying so here is what
  // stops someone "simplifying" this back to it.
  it('is not what the plain projection would say', async () => {
    const { sortAlongRoute } = await import('@rv/shared')
    const seiser = { id: 'seiser', ...SEISER_ALM }
    const kronplatz = { id: 'kronplatz', ...KRONPLATZ }
    expect(
      sortAlongRoute(SEISER_ALM, VERONA, [seiser, kronplatz], (s) => s).map(
        (s) => s.id,
      ),
    ).toEqual(['kronplatz', 'seiser'])
  })

  // Turning around, the nearest thing behind you is the first you reach.
  it('orders the ones behind by how far back they are', () => {
    const near = { id: 'near', lat: 46.6, lng: 11.65 }
    const far = { id: 'far', lat: 46.9, lng: 12.1 }
    const ordered = orderStopsFromHere(
      SEISER_ALM,
      VERONA,
      [far, near],
      (s) => s,
    )
    expect(ordered.map((s) => s.id)).toEqual(['near', 'far'])
  })
})
