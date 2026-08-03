import { describe, expect, it } from 'vitest'
import type { NamedPoint, SharedTripStop } from '@rv/shared'
import { sharedRoutePoints } from './sharedRoutePoints'

function stop(name: string, lat: number, lng: number): SharedTripStop {
  return { id: name, name, lat, lng, status: 'committed' }
}

const OSLO: NamedPoint = { name: 'Oslo', lat: 59.9139, lng: 10.7522 }
const OTTA: NamedPoint = { name: 'Otta', lat: 61.7725, lng: 9.5406 }
/** What a trip whose start or finish was never filled in actually holds. */
const UNSET: NamedPoint = { name: '', lat: 0, lng: 0 }

describe('sharedRoutePoints', () => {
  it('runs from the start, through the stops in order, to the finish', () => {
    expect(
      sharedRoutePoints(
        [stop('Lillehammer', 61.1153, 10.4662), stop('Vinstra', 61.5947, 9.7488)],
        OSLO,
        OTTA,
      ),
    ).toEqual([
      { lat: 59.9139, lng: 10.7522 },
      { lat: 61.1153, lng: 10.4662 },
      { lat: 61.5947, lng: 9.7488 },
      { lat: 61.7725, lng: 9.5406 },
    ])
  })

  it('leaves out a start or finish the traveler never set', () => {
    // (0, 0) is in the Atlantic: including it would fit the map to a box
    // spanning the Gulf of Guinea and Norway, leaving the actual route as a
    // smudge in one corner.
    const points = sharedRoutePoints([stop('Lillehammer', 61.1153, 10.4662)], UNSET, UNSET)
    expect(points).toEqual([{ lat: 61.1153, lng: 10.4662 }])
  })

  it('has nothing to draw for a trip with no stops and no route', () => {
    expect(sharedRoutePoints([], UNSET, UNSET)).toEqual([])
  })

  it('still draws the leg between start and finish before any stop exists', () => {
    expect(sharedRoutePoints([], OSLO, OTTA)).toHaveLength(2)
  })
})
