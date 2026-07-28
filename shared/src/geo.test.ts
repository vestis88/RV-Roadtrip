import { describe, expect, it } from 'vitest'
import {
  buildRouteBackbone,
  estimateDetourKm,
  haversineDistanceKm,
} from './geo.js'

const OSLO = { lat: 59.9139, lng: 10.7522 }
const ROME = { lat: 41.9028, lng: 12.4964 }
const LILLEHAMMER = { lat: 61.1153, lng: 10.4662 }
const INNSBRUCK = { lat: 47.2692, lng: 11.4041 }

describe('haversineDistanceKm', () => {
  it('is zero for a point against itself', () => {
    expect(haversineDistanceKm(OSLO, OSLO)).toBe(0)
  })

  it('is symmetric', () => {
    expect(haversineDistanceKm(OSLO, ROME)).toBeCloseTo(
      haversineDistanceKm(ROME, OSLO),
      9,
    )
  })

  it('matches a known great-circle distance', () => {
    // Oslo → Rome is ~2010 km as the crow flies.
    expect(haversineDistanceKm(OSLO, ROME)).toBeGreaterThan(1950)
    expect(haversineDistanceKm(OSLO, ROME)).toBeLessThan(2070)
  })

  it('measures a degree of latitude as ~111 km anywhere', () => {
    expect(haversineDistanceKm({ lat: 0, lng: 0 }, { lat: 1, lng: 0 })).toBeCloseTo(
      111.19,
      1,
    )
    expect(
      haversineDistanceKm({ lat: 59, lng: 10 }, { lat: 60, lng: 10 }),
    ).toBeCloseTo(111.19, 1)
  })

  it('shrinks a degree of longitude toward the poles', () => {
    const atEquator = haversineDistanceKm(
      { lat: 0, lng: 0 },
      { lat: 0, lng: 1 },
    )
    const atSixty = haversineDistanceKm({ lat: 60, lng: 0 }, { lat: 60, lng: 1 })
    // cos(60°) = 0.5, so a degree of longitude is half as wide up there.
    expect(atSixty).toBeCloseTo(atEquator / 2, 0)
  })
})

describe('buildRouteBackbone', () => {
  it('runs start → given points → end', () => {
    expect(buildRouteBackbone(OSLO, [LILLEHAMMER, INNSBRUCK], ROME)).toEqual([
      OSLO,
      LILLEHAMMER,
      INNSBRUCK,
      ROME,
    ])
  })

  it('sorts points along the start→end corridor instead of trusting the given order', () => {
    // Innsbruck is passed FIRST but sits much further along toward Rome;
    // Lillehammer is passed SECOND but sits north of Oslo, before the start.
    // Trusting the caller's order would put a stop that belongs early in the
    // trip after the one nearest the destination — the exact bug this sort
    // exists to prevent.
    expect(buildRouteBackbone(OSLO, [INNSBRUCK, LILLEHAMMER], ROME)).toEqual([
      OSLO,
      LILLEHAMMER,
      INNSBRUCK,
      ROME,
    ])
  })

  it('keeps a point that projects before the start at the front of the corridor', () => {
    // Straight north-to-south corridor: a point north of the start has a
    // negative projection and must still sort ahead of everything else,
    // not be clamped to the middle.
    const backbone = buildRouteBackbone(
      { lat: 50, lng: 10 },
      [
        { lat: 45, lng: 10 },
        { lat: 55, lng: 10 },
      ],
      { lat: 40, lng: 10 },
    )
    expect(backbone).toEqual([
      { lat: 50, lng: 10 },
      { lat: 55, lng: 10 },
      { lat: 45, lng: 10 },
      { lat: 40, lng: 10 },
    ])
  })

  it('falls back to the given order when either end is missing', () => {
    expect(buildRouteBackbone(undefined, [INNSBRUCK, LILLEHAMMER], ROME)).toEqual(
      [INNSBRUCK, LILLEHAMMER, ROME],
    )
    expect(buildRouteBackbone(OSLO, [INNSBRUCK, LILLEHAMMER], undefined)).toEqual(
      [OSLO, INNSBRUCK, LILLEHAMMER],
    )
  })

  it('drops a missing start or end instead of emitting NaN coordinates', () => {
    expect(buildRouteBackbone(OSLO, [], undefined)).toEqual([OSLO])
    expect(buildRouteBackbone(undefined, [], undefined)).toEqual([])
    expect(
      buildRouteBackbone({ lat: NaN, lng: NaN }, [], ROME),
    ).toEqual([ROME])
  })

  it('leaves the given array untouched', () => {
    const points = [INNSBRUCK, LILLEHAMMER]
    buildRouteBackbone(OSLO, points, ROME)
    expect(points).toEqual([INNSBRUCK, LILLEHAMMER])
  })

  it('handles a degenerate corridor whose start and end coincide', () => {
    const backbone = buildRouteBackbone(OSLO, [LILLEHAMMER], OSLO)
    expect(backbone).toEqual([OSLO, LILLEHAMMER, OSLO])
  })
})

describe('estimateDetourKm', () => {
  it('is ~0 for a point sitting on a backbone leg', () => {
    const backbone = [
      { lat: 50, lng: 10 },
      { lat: 54, lng: 10 },
    ]
    expect(estimateDetourKm({ lat: 52, lng: 10 }, backbone)).toBeCloseTo(0, 2)
  })

  it('matches the planar two-legs-of-a-triangle result for a point off to the side', () => {
    const backbone = [
      { lat: 50, lng: 10 },
      { lat: 54, lng: 10 },
    ]
    const aside = { lat: 52, lng: 11 }

    // A candidate offset by h from the midpoint of a leg of length L turns
    // that leg into two hypotenuses, so the extra distance is
    // 2·√((L/2)² + h²) − L. Quadratic in h, not linear — a small sideways
    // offset on a long leg costs very little, which is what makes the figure
    // useful for ranking candidates against each other.
    const legKm = haversineDistanceKm(backbone[0], backbone[1])
    const offsetKm = haversineDistanceKm({ lat: 52, lng: 10 }, aside)
    const expected = 2 * Math.hypot(legKm / 2, offsetKm) - legKm

    const detour = estimateDetourKm(aside, backbone)
    expect(detour).toBeGreaterThan(0)
    expect(detour).toBeCloseTo(expected, 0)
  })

  it('picks the cheapest leg, not the first one', () => {
    // A dog-leg backbone with the candidate on the SECOND leg: inserting it
    // into the first would cost hundreds of km, so a near-zero result can
    // only come from minimising across legs.
    const backbone = [
      { lat: 50, lng: 10 },
      { lat: 54, lng: 10 },
      { lat: 54, lng: 20 },
    ]
    expect(estimateDetourKm({ lat: 54, lng: 15 }, backbone)).toBeLessThan(1)
  })

  it('grows with distance from the route', () => {
    const backbone = [
      { lat: 50, lng: 10 },
      { lat: 54, lng: 10 },
    ]
    const near = estimateDetourKm({ lat: 52, lng: 10.5 }, backbone)
    const far = estimateDetourKm({ lat: 52, lng: 13 }, backbone)
    expect(far).toBeGreaterThan(near)
  })

  it('returns 0 rather than throwing or NaN on a degenerate backbone', () => {
    expect(estimateDetourKm({ lat: 52, lng: 10 }, [])).toBe(0)
    expect(estimateDetourKm({ lat: 52, lng: 10 }, [{ lat: 50, lng: 10 }])).toBe(
      0,
    )
  })

  it('never reports a negative detour for a point exactly on an endpoint', () => {
    const backbone = [
      { lat: 50, lng: 10 },
      { lat: 54, lng: 10 },
    ]
    expect(estimateDetourKm({ lat: 50, lng: 10 }, backbone)).toBe(0)
  })
})
