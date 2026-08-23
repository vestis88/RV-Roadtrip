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
/** Real driving totals for the whole point sequence, summed across chunks. */
export interface RouteTotals {
  distanceKm: number
  durationMin: number
}

/**
 * Adds up every leg of every chunk. `routes[0]` is the route Directions
 * chose and the one being drawn, so these totals always describe the line
 * actually on screen. A leg missing distance/duration contributes nothing
 * rather than NaN — one malformed leg should cost its own contribution, not
 * poison the entire total into unreadability.
 */
function sumRouteTotals(results: google.maps.DirectionsResult[]): RouteTotals {
  let meters = 0
  let seconds = 0
  for (const result of results) {
    for (const leg of result.routes[0]?.legs ?? []) {
      meters += leg.distance?.value ?? 0
      seconds += leg.duration?.value ?? 0
    }
  }
  return { distanceKm: meters / 1000, durationMin: seconds / 60 }
}

/** One hop of the drawn route: point N to point N+1. */
export interface RouteLeg {
  distanceKm: number
  durationMin: number
}

/**
 * The same legs `sumRouteTotals` adds up, kept individually.
 *
 * They were fetched and thrown away — the totals line said "24 h 15 min
 * driving · 2107 km" and nothing said what any single hop cost, which is
 * exactly the number needed to decide whether a stop is worth keeping.
 * Requested 2026-08-23: "It should be possible to determine the distance and
 * time between locked in stops."
 *
 * Flattened across chunks in request order, so the result is the whole
 * journey's hops end to end. That correspondence is what lets the caller
 * pair leg i with the gap between routed point i and i+1 — see
 * MAX_DIRECTIONS_POINTS_PER_REQUEST for why there is more than one chunk,
 * and note that chunks overlap by one point (each starts where the last
 * ended), so no hop is counted twice and none is missed.
 */
function routeLegs(results: google.maps.DirectionsResult[]): RouteLeg[] {
  return results.flatMap((result) =>
    (result.routes[0]?.legs ?? []).map((leg) => ({
      distanceKm: (leg.distance?.value ?? 0) / 1000,
      durationMin: (leg.duration?.value ?? 0) / 60,
    })),
  )
}

export function DirectionsRoute({
  points,
  onError,
  onTotals,
  onLegs,
  optimizeOrder = false,
  onOrder,
}: {
  points: LatLng[]
  onError: (message: string | null) => void
  /**
   * Real driving distance and time for `points`, or null while unknown —
   * before the requests land, and after any of them fails.
   *
   * These come free: the Directions results were already being fetched to
   * draw the route and every field except the geometry was thrown away.
   *
   * Null rather than a partial sum on failure, deliberately. Chunks are
   * awaited in sequence and a rejection aborts the rest, so a "total" built
   * from what arrived would be a real number describing a fraction of the
   * trip — indistinguishable, on screen, from an honest one. An unknown
   * total shows as unknown.
   */
  onTotals?: (totals: RouteTotals | null) => void
  /**
   * Every hop of the drawn route, in request order — see routeLegs. Must be
   * a STABLE identity (useCallback), like onTotals: this hook lists it in a
   * dependency array, so a new function per render re-fires the Directions
   * request and cancels the one in flight. That circuit is written up in
   * routeOrder.ts and has been walked into twice.
   */
  onLegs?: (legs: RouteLeg[] | null) => void
  /**
   * Let Google choose the order of the intermediate points, rather than
   * driving them in the order given.
   *
   * OFF by default, and it must stay off for a generated plan: those points
   * are days, in date order, and re-ordering the drawn line would have it
   * contradict the itinerary underneath it.
   *
   * ON for explore mode, where the order was only ever our own guess — a
   * scalar projection onto the straight start→end line (sortAlongRoute),
   * which cannot know that the sea is in the way. Reported as a trip that
   * drove north through Sweden and around the Gulf of Bothnia to reach
   * Estonia, because "northern Sweden" projected before "Saaremaa" on that
   * line and the waypoints were then handed to Directions as a fixed
   * sequence. Google routes on real roads and, since nothing here sets
   * avoidFerries, real ferries.
   */
  optimizeOrder?: boolean
  /**
   * The order Google chose, as indices into the intermediate points (i.e.
   * `points` without its first and last). Fires only when the order was
   * actually optimized, so a caller can bring everything else that depends
   * on the route order — the corridor it sends to the server, the names it
   * puts in a search prompt — into line with what is drawn.
   */
  onOrder?: (order: number[]) => void
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
    onTotals?.(null)

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
      // Optimization is only meaningful over the whole route. Chunked, each
      // request would reorder within its own slice and leave the slices in
      // the original sequence — a locally tidy, globally wrong answer, and
      // worse than not trying. A trip long enough to chunk keeps the order
      // it was given.
      const canOptimize = optimizeOrder && segments.length === 1

      for (const segment of segments) {
        const result = await service.route({
          origin: segment[0],
          destination: segment[segment.length - 1],
          waypoints: segment
            .slice(1, -1)
            .map((location) => ({ location, stopover: true })),
          travelMode: routesLibrary.TravelMode.DRIVING,
          ...(canOptimize ? { optimizeWaypoints: true } : {}),
        })
        if (cancelled) return
        results.push(result)
      }

      if (canOptimize) {
        const order = results[0]?.routes[0]?.waypoint_order
        if (order) onOrder?.(order)
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
      onTotals?.(sumRouteTotals(results))
      onLegs?.(routeLegs(results))
    }

    run().catch((error: unknown) => {
      console.warn('Directions route failed', error)
      if (!cancelled) {
        onError(describeDirectionsError(error))
        onTotals?.(null)
        onLegs?.(null)
      }
    })

    return () => {
      cancelled = true
      for (const renderer of renderers) renderer.setMap(null)
    }
  }, [map, routesLibrary, points, onError, onTotals, onLegs, optimizeOrder, onOrder])

  if (routedPoints === points || points.length < 2) return null
  return <Polyline path={points} {...ROUTE_STROKE} />
}
