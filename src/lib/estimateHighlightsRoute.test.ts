import { describe, expect, it } from 'vitest'
import {
  buildIdealRouteBackbone,
  describeDetour,
  estimateDetourKm,
  type HighlightCandidateStop,
  type HighlightRegion,
} from './estimateHighlightsRoute'
import { haversineDistanceKm } from './executionMode'

const OSLO = { lat: 59.9139, lng: 10.7522 }
const ROME = { lat: 41.9028, lng: 12.4964 }

function stop(
  town: string,
  priority: HighlightCandidateStop['priority'],
  coords?: { lat: number; lng: number },
): HighlightCandidateStop {
  return { town, country: 'NO', why: `Why ${town}.`, priority, ...coords }
}

function region(
  name: string,
  candidateStops: HighlightCandidateStop[],
): HighlightRegion {
  return {
    region: name,
    country: 'NO',
    reasoning: `About ${name}.`,
    candidateStops,
  }
}

describe('buildIdealRouteBackbone', () => {
  it('runs start → located must-sees in listed order → end', () => {
    const backbone = buildIdealRouteBackbone(
      OSLO,
      [
        region('Fjords', [
          stop('Lillehammer', 'must-see', { lat: 61.1153, lng: 10.4662 }),
          stop('Geiranger', 'worth-a-detour', { lat: 62.1008, lng: 7.2064 }),
        ]),
        region('Alps', [
          stop('Innsbruck', 'must-see', { lat: 47.2692, lng: 11.4041 }),
        ]),
      ],
      ROME,
    )

    expect(backbone).toEqual([
      OSLO,
      { lat: 61.1153, lng: 10.4662 },
      { lat: 47.2692, lng: 11.4041 },
      ROME,
    ])
  })

  it('skips regions with no must-see stops rather than contributing one point each', () => {
    const backbone = buildIdealRouteBackbone(
      OSLO,
      [
        region('No must-sees', [
          stop('Skien', 'worth-a-detour', { lat: 59.2, lng: 9.6 }),
          stop('Horten', 'nice-if-convenient', { lat: 59.4, lng: 10.5 }),
        ]),
        region('Alps', [
          stop('Innsbruck', 'must-see', { lat: 47.2692, lng: 11.4041 }),
        ]),
      ],
      ROME,
    )

    expect(backbone).toEqual([OSLO, { lat: 47.2692, lng: 11.4041 }, ROME])
  })

  it('skips must-sees that never geocoded', () => {
    const backbone = buildIdealRouteBackbone(
      OSLO,
      [region('Fjords', [stop('Nowhere', 'must-see')])],
      ROME,
    )

    expect(backbone).toEqual([OSLO, ROME])
  })

  it('drops a missing start or end point instead of emitting NaN coordinates', () => {
    const noEnd = buildIdealRouteBackbone(OSLO, [], undefined)
    expect(noEnd).toEqual([OSLO])

    const neither = buildIdealRouteBackbone(undefined, [], undefined)
    expect(neither).toEqual([])
  })
})

describe('estimateDetourKm', () => {
  it('is ~0 for a point sitting on a backbone leg', () => {
    // Three points on the same meridian: the middle one costs nothing to
    // visit on the way from the first to the last.
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

    // Hand-check on a flat triangle: a candidate offset by h from the
    // midpoint of a leg of length L turns that leg into two hypotenuses, so
    // the extra distance is 2·√((L/2)² + h²) − L. Note this is quadratic in
    // h, not linear — a small sideways offset on a long leg costs very
    // little, which is exactly the property that makes the figure useful for
    // ranking candidates.
    const legKm = haversineDistanceKm(backbone[0], backbone[1])
    const offsetKm = haversineDistanceKm({ lat: 52, lng: 10 }, aside)
    const expected = 2 * Math.hypot(legKm / 2, offsetKm) - legKm

    const detour = estimateDetourKm(aside, backbone)
    expect(detour).toBeGreaterThan(0)
    expect(detour).toBeCloseTo(expected, 0)
  })

  it('picks the cheapest leg, not the first one', () => {
    // A dog-leg backbone: the candidate sits on the SECOND leg. Inserting it
    // into the first leg instead would cost hundreds of km, so a near-zero
    // result can only come from minimising across legs.
    const backbone = [
      { lat: 50, lng: 10 },
      { lat: 54, lng: 10 },
      { lat: 54, lng: 20 },
    ]
    // Not exactly 0: a constant-latitude path isn't a great circle, so the
    // midpoint sits slightly off the geodesic between its neighbours.
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

describe('describeDetour', () => {
  const backbone = [
    { lat: 50, lng: 10 },
    { lat: 54, lng: 10 },
  ]

  it('calls must-sees on-route instead of giving them a number', () => {
    expect(
      describeDetour(
        stop('Lillehammer', 'must-see', { lat: 61, lng: 10 }),
        backbone,
      ),
    ).toEqual({ kind: 'on-route' })
  })

  it('reports an unknown location for a candidate that never geocoded', () => {
    expect(describeDetour(stop('Nowhere', 'worth-a-detour'), backbone)).toEqual(
      {
        kind: 'unknown-location',
      },
    )
  })

  it('reports a numeric detour for a located non-must-see', () => {
    const result = describeDetour(
      stop('Aside', 'worth-a-detour', { lat: 52, lng: 12 }),
      backbone,
    )
    expect(result.kind).toBe('detour')
    if (result.kind === 'detour') expect(result.km).toBeGreaterThan(50)
  })
})
