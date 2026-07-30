import { useEffect, useState } from 'react'
import { Polyline, useMap, useMapsLibrary } from '@vis.gl/react-google-maps'
import type { LatLng } from '@rv/shared'
import { chunkRouteSegments } from '../lib/buildOverviewRoute'

const ROUTE_STROKE = {
  strokeColor: '#ea580c',
  strokeOpacity: 0.8,
  strokeWeight: 4,
}

/**
 * Pulls a readable reason out of whatever the Directions promise rejects
 * with — usually an object carrying a `code` (a google.maps.DirectionsStatus
 * like REQUEST_DENIED or OVER_QUERY_LIMIT) and/or a `message`, but the shape
 * isn't guaranteed, so this degrades to String(error) rather than throwing.
 * Console-only logging left this undiagnosable on a phone with no devtools
 * access — surfacing it in the UI is what makes it reportable at all.
 */
function describeDirectionsError(error: unknown): string {
  if (error && typeof error === 'object') {
    const code = 'code' in error ? String((error as { code: unknown }).code) : undefined
    const message =
      'message' in error ? String((error as { message: unknown }).message) : undefined
    if (code && message) return `${code}: ${message}`
    if (code) return code
    if (message) return message
  }
  return String(error)
}

/**
 * A real driving route through an ordered point sequence, chunked to respect
 * the Directions API's per-request point cap (`MAX_DIRECTIONS_POINTS_PER_REQUEST`).
 * Shared by the overview map (the whole trip's route) and the day view map
 * (one day's route through its meals/activities/overnight).
 *
 * Straight lines between the points were the first version of this, and they
 * lie about the one thing this is for: a 60 km hop over a fjord or an alpine
 * pass reads identically to a 60 km motorway run, so the shape on screen has
 * nothing to do with the shape of the drive.
 *
 * The straight polyline survives as the fallback state rather than as a
 * separate error path — it renders immediately, the Directions results
 * replace it when they arrive, and if any segment fails (no key, quota,
 * offline) it is simply never replaced. A partially-routed map with a gap
 * where one request 403'd would be worse than a consistently approximate one.
 */
export function DirectionsRoute({
  points,
  onError,
}: {
  points: LatLng[]
  onError: (message: string | null) => void
}) {
  const map = useMap()
  const routesLibrary = useMapsLibrary('routes')
  // Holds the exact array that is currently drawn as real directions, so a
  // changed selection (a new array) falls back to the polyline until its own
  // requests land, with no extra reset state to keep in sync.
  const [routedPoints, setRoutedPoints] = useState<LatLng[] | null>(null)

  useEffect(() => {
    if (!map || !routesLibrary || points.length < 2) return
    onError(null)

    const segments = chunkRouteSegments(points)
    const renderers: google.maps.DirectionsRenderer[] = []
    let cancelled = false

    async function run() {
      if (!routesLibrary) return
      const service = new routesLibrary.DirectionsService()
      const results: google.maps.DirectionsResult[] = []

      // Sequential on purpose: a multi-week trip is several requests against
      // the same key the rest of the app is already using, and firing them
      // together is the reliable way to get rate-limited on exactly the trips
      // that need chunking in the first place.
      for (const segment of segments) {
        const result = await service.route({
          origin: segment[0],
          destination: segment[segment.length - 1],
          waypoints: segment
            .slice(1, -1)
            .map((location) => ({ location, stopover: true })),
          travelMode: routesLibrary.TravelMode.DRIVING,
        })
        if (cancelled) return
        results.push(result)
      }

      // Nothing is drawn until every segment is in hand, so the polyline
      // fallback is never half-covered by a route that stops mid-trip.
      for (const result of results) {
        const renderer = new routesLibrary.DirectionsRenderer({
          map,
          // The screen draws its own day badges and place pins; Directions'
          // A/B/C markers would bury them under less information.
          suppressMarkers: true,
          // Zoom drives the marker tiers here, so the route must not move the
          // camera out from under the traveler.
          preserveViewport: true,
          polylineOptions: ROUTE_STROKE,
        })
        renderer.setDirections(result)
        renderers.push(renderer)
      }
      setRoutedPoints(points)
    }

    run().catch((error: unknown) => {
      console.warn('Directions route failed', error)
      if (!cancelled) onError(describeDirectionsError(error))
    })

    return () => {
      cancelled = true
      for (const renderer of renderers) renderer.setMap(null)
    }
  }, [map, routesLibrary, points, onError])

  if (routedPoints === points || points.length < 2) return null
  return <Polyline path={points} {...ROUTE_STROKE} />
}
