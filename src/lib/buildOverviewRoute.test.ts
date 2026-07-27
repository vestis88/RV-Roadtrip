import { describe, expect, it } from 'vitest'
import {
  MAX_DIRECTIONS_POINTS_PER_REQUEST,
  buildOverviewRoutePoints,
  chunkRouteSegments,
  selectDayAnchors,
  type RouteActivityCandidate,
  type RouteDay,
} from './buildOverviewRoute'

function activity(
  lat: number,
  lng: number,
  extra: Partial<RouteActivityCandidate> = {},
): RouteActivityCandidate {
  return { lat, lng, status: 'suggested', ...extra }
}

function day(lat: number, lng: number, activities?: RouteActivityCandidate[]): RouteDay {
  return { overnight: { lat, lng }, activities }
}

/** A straight line of distinct points, long enough to need chunking. */
function line(count: number) {
  return Array.from({ length: count }, (_, i) => ({ lat: 50 + i, lng: 10 }))
}

describe('selectDayAnchors', () => {
  it('uses every selected activity, in listed order, ignoring ratings', () => {
    expect(
      selectDayAnchors([
        activity(1, 1, { rating: 4.9 }),
        activity(2, 2, { rating: 3.1, status: 'selected' }),
        activity(3, 3, { rating: 2.0, status: 'selected' }),
      ]),
    ).toEqual([
      { lat: 2, lng: 2 },
      { lat: 3, lng: 3 },
    ])
  })

  it('falls back to the single highest-rated activity when nothing is selected', () => {
    expect(
      selectDayAnchors([
        activity(1, 1, { rating: 4.2 }),
        activity(2, 2, { rating: 4.8 }),
        activity(3, 3, { rating: 3.9 }),
      ]),
    ).toEqual([{ lat: 2, lng: 2 }])
  })

  it('picks the first candidate rather than throwing when nothing has a rating', () => {
    expect(
      selectDayAnchors([activity(1, 1), activity(2, 2), activity(3, 3)]),
    ).toEqual([{ lat: 1, lng: 1 }])
  })

  it('ranks a rated candidate above an unrated one, whichever comes first', () => {
    expect(
      selectDayAnchors([activity(1, 1), activity(2, 2, { rating: 3.5 })]),
    ).toEqual([{ lat: 2, lng: 2 }])
    expect(
      selectDayAnchors([activity(1, 1, { rating: 3.5 }), activity(2, 2)]),
    ).toEqual([{ lat: 1, lng: 1 }])
  })

  it('never suggests a skipped activity, even when it is the best rated', () => {
    expect(
      selectDayAnchors([
        activity(1, 1, { rating: 5, status: 'skipped' }),
        activity(2, 2, { rating: 3 }),
      ]),
    ).toEqual([{ lat: 2, lng: 2 }])
  })

  it('contributes no anchor for a day with no activities, or with all of them skipped', () => {
    expect(selectDayAnchors(undefined)).toEqual([])
    expect(selectDayAnchors([])).toEqual([])
    expect(
      selectDayAnchors([
        activity(1, 1, { status: 'skipped' }),
        activity(2, 2, { status: 'skipped' }),
      ]),
    ).toEqual([])
  })

  it('ignores candidates with unusable coordinates', () => {
    expect(
      selectDayAnchors([
        activity(Number.NaN, 10, { rating: 5 }),
        activity(2, 2, { rating: 3 }),
      ]),
    ).toEqual([{ lat: 2, lng: 2 }])
  })
})

describe('buildOverviewRoutePoints', () => {
  it('runs overnight → that day’s anchors, day by day', () => {
    expect(
      buildOverviewRoutePoints([
        day(50, 10, [activity(50.5, 10.5, { rating: 4.5 })]),
        day(51, 11, [
          activity(51.5, 11.5, { rating: 2, status: 'selected' }),
          activity(51.9, 11.9, { rating: 4.9 }),
        ]),
      ]),
    ).toEqual([
      { lat: 50, lng: 10 },
      { lat: 50.5, lng: 10.5 },
      { lat: 51, lng: 11 },
      { lat: 51.5, lng: 11.5 },
    ])
  })

  it('keeps a day with no activity data at all — just its overnight stop', () => {
    expect(buildOverviewRoutePoints([day(50, 10), day(51, 11, [])])).toEqual([
      { lat: 50, lng: 10 },
      { lat: 51, lng: 11 },
    ])
  })

  it('collapses a rest day that repeats the previous overnight', () => {
    expect(
      buildOverviewRoutePoints([day(50, 10), day(50, 10), day(51, 11)]),
    ).toEqual([
      { lat: 50, lng: 10 },
      { lat: 51, lng: 11 },
    ])
  })

  it('recomputes from the given selection — the same days select differently', () => {
    const days = [day(50, 10, [activity(50.5, 10.5, { rating: 4.9 }), activity(50.2, 10.2, { rating: 3 })])]
    expect(buildOverviewRoutePoints(days)).toEqual([
      { lat: 50, lng: 10 },
      { lat: 50.5, lng: 10.5 },
    ])

    const withSelection = [
      day(50, 10, [
        activity(50.5, 10.5, { rating: 4.9 }),
        activity(50.2, 10.2, { rating: 3, status: 'selected' }),
      ]),
    ]
    expect(buildOverviewRoutePoints(withSelection)).toEqual([
      { lat: 50, lng: 10 },
      { lat: 50.2, lng: 10.2 },
    ])
  })

  it('drops a day whose overnight stop has unusable coordinates', () => {
    expect(
      buildOverviewRoutePoints([
        { overnight: { lat: Number.NaN, lng: 10 } },
        day(51, 11),
      ]),
    ).toEqual([{ lat: 51, lng: 11 }])
  })
})

describe('chunkRouteSegments', () => {
  it('leaves a short trip as exactly one segment', () => {
    const points = line(8)
    expect(chunkRouteSegments(points)).toEqual([points])
  })

  it('keeps a trip that exactly fills the cap in one segment', () => {
    const points = line(MAX_DIRECTIONS_POINTS_PER_REQUEST)
    const segments = chunkRouteSegments(points)
    expect(segments).toHaveLength(1)
    expect(segments[0]).toHaveLength(MAX_DIRECTIONS_POINTS_PER_REQUEST)
  })

  it('never emits a segment over the cap, however long the trip', () => {
    for (const count of [26, 40, 41, 49, 50, 137]) {
      for (const segment of chunkRouteSegments(line(count))) {
        expect(segment.length).toBeLessThanOrEqual(
          MAX_DIRECTIONS_POINTS_PER_REQUEST,
        )
        expect(segment.length).toBeGreaterThanOrEqual(2)
      }
    }
  })

  it('shares a boundary point between consecutive segments', () => {
    const segments = chunkRouteSegments(line(60))
    expect(segments.length).toBeGreaterThan(1)
    for (let i = 1; i < segments.length; i++) {
      const previous = segments[i - 1]
      expect(segments[i][0]).toEqual(previous[previous.length - 1])
    }
  })

  it('covers the whole sequence once when the overlaps are removed', () => {
    const points = line(60)
    const segments = chunkRouteSegments(points)
    const rejoined = segments.flatMap((segment, i) =>
      i === 0 ? segment : segment.slice(1),
    )
    expect(rejoined).toEqual(points)
  })

  it('yields nothing for a sequence that cannot describe a drive', () => {
    expect(chunkRouteSegments([])).toEqual([])
    expect(chunkRouteSegments([{ lat: 50, lng: 10 }])).toEqual([])
  })

  it('honours a smaller cap and refuses a nonsensical one', () => {
    expect(chunkRouteSegments(line(5), 3)).toEqual([
      [
        { lat: 50, lng: 10 },
        { lat: 51, lng: 10 },
        { lat: 52, lng: 10 },
      ],
      [
        { lat: 52, lng: 10 },
        { lat: 53, lng: 10 },
        { lat: 54, lng: 10 },
      ],
    ])
    // A cap below 2 can't hold an origin and a destination; clamping beats
    // looping forever.
    expect(chunkRouteSegments(line(4), 1).length).toBe(3)
  })
})
