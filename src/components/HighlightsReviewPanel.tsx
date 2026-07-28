import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { addDoc, collection, serverTimestamp } from 'firebase/firestore'
import {
  AdvancedMarker,
  Map as GoogleMap,
  Polyline,
  useMap,
  useMapsLibrary,
} from '@vis.gl/react-google-maps'
import type { LatLng, NamedPoint } from '@rv/shared'
import { db } from '../lib/firebase'
import {
  buildIdealRouteBackbone,
  describeDetour,
  findCheapestBackboneLeg,
  hasLocation,
  type DetourEstimate,
  type HighlightCandidateStop,
  type HighlightPriority,
  type HighlightRegion,
  type LocatedStop,
} from '../lib/estimateHighlightsRoute'

interface RegionHighlightsResponse {
  regions: HighlightRegion[]
}

interface HighlightsReviewPanelProps {
  tripId: string
  pendingHighlights: unknown
  /** Anchors both the map and the ideal-route backbone detours are measured against. */
  startPoint: NamedPoint
  endPoint: NamedPoint
}

// Low to high — "up" promotes a candidate toward must-see, "down" demotes it
// toward nice-if-convenient. This is the field OUTLINE_SYSTEM_PROMPT actually
// reasons over (functions/src/prompts/planTripPrompt.ts), so it's the one
// control that meaningfully changes what the outline phase does with a stop.
const PRIORITY_TIERS: HighlightPriority[] = [
  'nice-if-convenient',
  'worth-a-detour',
  'must-see',
]

const PRIORITY_LABEL: Record<HighlightPriority, string> = {
  'must-see': 'Must-see',
  'worth-a-detour': 'Worth a detour',
  'nice-if-convenient': 'Nice if convenient',
}

// Directions caps a request at 25 points total, so 23 intermediate waypoints
// on top of an origin and a destination. A shortlist generous enough to blow
// through that is possible on a long multi-country trip; truncating the
// backbone keeps a route on screen instead of failing the whole call.
const MAX_DIRECTIONS_WAYPOINTS = 23

const ROUTE_STROKE = {
  strokeColor: '#ea580c',
  strokeOpacity: 0.85,
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
 * Draws the real driving route through the backbone. A straight polyline
 * between must-sees was the first version of this and it actively misled —
 * it implied detour costs that the road network doesn't charge (and hid ones
 * it does, around fjords and mountains), which is the specific thing this
 * screen exists to let the traveler judge.
 *
 * The straight polyline survives as the fallback state rather than as an
 * error path (mirrors OverviewMapScreen's TripRoute): it renders immediately
 * and is only replaced once Directions actually resolves for this exact
 * backbone, so a failed/blocked/unconfigured Directions call still leaves a
 * line on screen instead of nothing at all — a review screen with no route
 * line is much easier to mistake for "broken" than one that's merely
 * approximate.
 */
function BackboneRoute({
  backbone,
  onError,
  onRouted,
}: {
  backbone: LatLng[]
  onError: (message: string | null) => void
  /** Real per-leg distances (km), once known — null while unrouted/unknown. */
  onRouted: (legDistancesKm: number[] | null) => void
}) {
  const map = useMap()
  const routesLibrary = useMapsLibrary('routes')
  const [routedBackbone, setRoutedBackbone] = useState<LatLng[] | null>(null)

  useEffect(() => {
    if (!map || !routesLibrary || backbone.length < 2) return
    onError(null)
    onRouted(null)

    const renderer = new routesLibrary.DirectionsRenderer({
      map,
      // The panel draws its own markers, with priority baked into them —
      // Directions' default A/B/C pins would sit on top saying less.
      suppressMarkers: true,
      // The panel frames the map itself, around every candidate rather than
      // just the routed ones.
      preserveViewport: true,
      polylineOptions: ROUTE_STROKE,
    })

    const via = backbone.slice(1, -1).slice(0, MAX_DIRECTIONS_WAYPOINTS)
    let cancelled = false

    new routesLibrary.DirectionsService()
      .route({
        origin: backbone[0],
        destination: backbone[backbone.length - 1],
        waypoints: via.map((location) => ({ location, stopover: true })),
        travelMode: routesLibrary.TravelMode.DRIVING,
      })
      .then((result) => {
        if (cancelled) return
        renderer.setDirections(result)
        setRoutedBackbone(backbone)
        // Only meaningful when nothing got truncated by MAX_DIRECTIONS_WAYPOINTS
        // above — a leg count that doesn't match the full backbone can't be
        // safely indexed by findCheapestBackboneLeg (which reasons over the
        // untruncated backbone), so real per-candidate detours are skipped
        // rather than risk lining up the wrong leg.
        const legs = result.routes[0]?.legs ?? []
        onRouted(
          legs.length === backbone.length - 1
            ? legs.map((leg) => (leg.distance?.value ?? 0) / 1000)
            : null,
        )
      })
      .catch((error: unknown) => {
        console.warn('Highlights route directions failed', error)
        if (!cancelled) onError(describeDirectionsError(error))
      })

    return () => {
      cancelled = true
      renderer.setMap(null)
    }
  }, [map, routesLibrary, backbone, onError, onRouted])

  if (routedBackbone === backbone || backbone.length < 2) return null
  return <Polyline path={backbone} {...ROUTE_STROKE} />
}

/** Keeps every candidate and both endpoints in frame without hand-picking a zoom. */
function FitToPoints({ points }: { points: LatLng[] }) {
  const map = useMap()

  useEffect(() => {
    if (!map || points.length === 0) return
    const bounds = new google.maps.LatLngBounds()
    for (const point of points) bounds.extend(point)
    map.fitBounds(bounds, 32)
  }, [map, points])

  return null
}

// How close in to zoom when a traveler asks to see one specific candidate —
// close enough to read the immediate area, not so close the map feels empty.
const FOCUS_ZOOM = 11

/**
 * Pans (and zooms in, if needed) to whichever candidate is focused — set by
 * either clicking a stop's name in the list below or a marker on the map
 * itself, so both directions land on the same "look at this one" behavior.
 */
function PanToSelected({ target }: { target: LatLng | null }) {
  const map = useMap()

  useEffect(() => {
    if (!map || !target) return
    map.panTo(target)
    map.setZoom(FOCUS_ZOOM)
  }, [map, target])

  return null
}

interface DetourCandidate {
  regionIndex: number
  stopIndex: number
  point: LatLng
}

/**
 * Upgrades each non-must-see candidate's detour from the instant haversine
 * estimate to a real Directions-measured figure, one candidate at a time —
 * same "sequential, not parallel" reasoning as BackboneRoute's own chunked
 * requests, since this is yet more requests against the same key. Only runs
 * once the backbone's own real route is known (legDistancesKm), since a
 * candidate's real detour is measured against that route's own real leg
 * distance, not another estimate.
 *
 * Renders nothing; reports each result up as it resolves via onUpdate rather
 * than batching, so the list upgrades candidate-by-candidate instead of
 * waiting for all of them before showing any real figure.
 */
function RealDetours({
  backbone,
  legDistancesKm,
  candidates,
  onUpdate,
}: {
  backbone: LatLng[]
  legDistancesKm: number[] | null
  candidates: DetourCandidate[]
  onUpdate: (key: string, km: number) => void
}) {
  const routesLibrary = useMapsLibrary('routes')

  useEffect(() => {
    if (
      !routesLibrary ||
      !legDistancesKm ||
      legDistancesKm.length !== backbone.length - 1
    ) {
      return
    }
    let cancelled = false

    async function run() {
      const service = new routesLibrary!.DirectionsService()
      for (const candidate of candidates) {
        if (cancelled) return
        const legIndex = findCheapestBackboneLeg(candidate.point, backbone)
        if (legIndex === null) continue

        try {
          const result = await service.route({
            origin: backbone[legIndex],
            destination: backbone[legIndex + 1],
            waypoints: [{ location: candidate.point, stopover: true }],
            travelMode: routesLibrary!.TravelMode.DRIVING,
          })
          if (cancelled) return
          const legs = result.routes[0]?.legs ?? []
          const viaKm = legs.reduce(
            (sum, leg) => sum + (leg.distance?.value ?? 0) / 1000,
            0,
          )
          onUpdate(
            `${candidate.regionIndex}-${candidate.stopIndex}`,
            Math.max(0, viaKm - legDistancesKm![legIndex]),
          )
        } catch (error) {
          // One candidate's real detour failing to resolve just leaves it
          // showing the haversine estimate — not worth surfacing the way the
          // main route's own failure is, since the estimate already stands
          // on its own as a reasonable fallback.
          console.warn('Real detour lookup failed', candidate, error)
        }
      }
    }

    run().catch((error: unknown) => console.warn('Real detour loop failed', error))

    return () => {
      cancelled = true
    }
  }, [routesLibrary, backbone, legDistancesKm, candidates, onUpdate])

  return null
}

/**
 * Compact on purpose: this sits on the map, not in the list, so a full town
 * name plus chips (as the list row gets) would crowd out the map itself on a
 * phone — the full name is still available via the marker's title (hover) and
 * unabbreviated in the list row the marker scrolls to on tap.
 */
function CandidateMarker({
  stop,
  selected,
}: {
  stop: HighlightCandidateStop
  selected: boolean
}) {
  const mustSee = stop.priority === 'must-see'
  return (
    <div
      className={`flex h-6 max-w-20 items-center overflow-hidden rounded-full border-2 px-1.5 text-[10px] font-semibold shadow-md transition ${
        selected ? 'scale-110 border-orange-500' : 'border-white dark:border-neutral-900'
      } ${
        mustSee
          ? 'bg-orange-600 text-white'
          : 'bg-white text-neutral-700 dark:bg-neutral-800 dark:text-neutral-200'
      }`}
    >
      <span className="truncate">{stop.town}</span>
    </div>
  )
}

/** The name/chips/description/controls for one candidate's row in the list. */
function CandidateDetails({
  stop,
  regionIndex,
  stopIndex,
  detour,
  onFocus,
  onRaise,
  onLower,
  onRemove,
}: {
  stop: HighlightCandidateStop
  regionIndex: number
  stopIndex: number
  detour: DetourEstimate
  onFocus?: () => void
  onRaise: () => void
  onLower: () => void
  onRemove: () => void
}) {
  return (
    <>
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex flex-wrap items-center gap-1.5">
          {onFocus ? (
            <button
              type="button"
              data-testid={`highlights-stop-focus-${regionIndex}-${stopIndex}`}
              onClick={onFocus}
              className="font-medium text-neutral-900 underline decoration-dotted underline-offset-2 dark:text-white"
            >
              {stop.town}
            </button>
          ) : (
            <p className="font-medium text-neutral-900 dark:text-white">
              {stop.town}
            </p>
          )}
          <span
            data-testid={`highlights-stop-priority-${regionIndex}-${stopIndex}`}
            className="chip chip-neutral"
          >
            {PRIORITY_LABEL[stop.priority]}
          </span>
          {/* Provenance, not a control: these behave exactly like any other
              candidate (same ▲/▼/Remove, same detour badge). The tag exists
              so a traveler can tell at a glance which suggestions a web
              search turned up versus which came from the curated pass,
              instead of the two being silently indistinguishable. */}
          {stop.source === 'search' && (
            <span
              data-testid={`highlights-stop-source-${regionIndex}-${stopIndex}`}
              className="chip chip-neutral"
            >
              Found via web search
            </span>
          )}
          {detour.kind !== 'unknown-location' && (
            <span
              data-testid={`highlights-stop-detour-${regionIndex}-${stopIndex}`}
              className={
                detour.kind === 'on-route' ? 'chip chip-accent' : 'chip chip-neutral'
              }
            >
              {detour.kind === 'on-route'
                ? 'On route'
                : `${detour.isEstimate ? '≈' : ''}+${Math.round(detour.km)} km detour`}
            </span>
          )}
        </div>
        {/* Deliberately not truncated: this description is the whole reason
            the traveler can decide here instead of going and looking the
            town up somewhere else. */}
        <p className="text-xs text-neutral-500 dark:text-neutral-400">{stop.why}</p>
      </div>
      <div className="flex shrink-0 flex-col">
        <button
          type="button"
          aria-label="Raise priority"
          data-testid={`highlights-stop-up-${regionIndex}-${stopIndex}`}
          disabled={stop.priority === 'must-see'}
          onClick={onRaise}
          className="px-1 text-xs text-neutral-500 disabled:opacity-30 dark:text-neutral-400"
        >
          ▲
        </button>
        <button
          type="button"
          aria-label="Lower priority"
          data-testid={`highlights-stop-down-${regionIndex}-${stopIndex}`}
          disabled={stop.priority === 'nice-if-convenient'}
          onClick={onLower}
          className="px-1 text-xs text-neutral-500 disabled:opacity-30 dark:text-neutral-400"
        >
          ▼
        </button>
      </div>
      <button
        type="button"
        data-testid={`highlights-stop-remove-${regionIndex}-${stopIndex}`}
        onClick={onRemove}
        className="shrink-0 text-xs text-red-600 underline underline-offset-2 dark:text-red-400"
      >
        Remove
      </button>
    </>
  )
}

/**
 * Interactive/transparent route planning's review pause (implemented
 * 2026-07-27): the highlights phase already produces exactly the data this
 * surfaces — ranked candidate stops per region with a reasoning string —
 * previously never shown to the traveler. Editing here (re-rank, remove, a
 * free-text note) reshapes the next phase's input; it doesn't touch the
 * outline/detail prompts themselves.
 *
 * The map and per-stop detour figures exist because the list alone was
 * unusable on a phone: a town name and one clipped sentence gives a traveler
 * no way to tell whether keeping a candidate costs an hour or a day, so every
 * decision meant leaving the app to look the place up.
 */
export function HighlightsReviewPanel({
  tripId,
  pendingHighlights,
  startPoint,
  endPoint,
}: HighlightsReviewPanelProps) {
  const [highlights, setHighlights] = useState<RegionHighlightsResponse>(
    () => (pendingHighlights as RegionHighlightsResponse) ?? { regions: [] },
  )
  const [note, setNote] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [routeError, setRouteError] = useState<string | null>(null)
  const [legDistancesKm, setLegDistancesKm] = useState<number[] | null>(null)
  const [realDetours, setRealDetours] = useState<Map<string, number>>(new Map())
  const [selectedStop, setSelectedStop] = useState<{
    regionIndex: number
    stopIndex: number
  } | null>(null)

  // Keyed by "regionIndex-stopIndex". The map is a separate DOM subtree (a
  // Google Maps portal) from the scrollable list below it, so tapping a
  // marker can't rely on the browser's own "scroll to this element" —
  // scrollToStop below does it by hand via these refs.
  const stopRowRefs = useRef(new Map<string, HTMLDivElement>())

  const scrollToStop = useCallback((regionIndex: number, stopIndex: number) => {
    stopRowRefs.current
      .get(`${regionIndex}-${stopIndex}`)
      ?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }, [])

  // Derived from live state, not from the pending highlights as loaded:
  // promoting a stop to must-see puts it INTO the backbone, which changes
  // what every other candidate's detour is measured against. Recomputing on
  // each edit is what makes the ▲/▼ buttons show their own consequences.
  const backbone = useMemo(
    () => buildIdealRouteBackbone(startPoint, highlights.regions, endPoint),
    [startPoint, highlights.regions, endPoint],
  )

  // A new backbone invalidates every real detour measured against the old
  // one — reset synchronously during render (React's documented pattern for
  // "adjusting state when a prop changes") rather than in an effect, so a
  // stale real figure is never shown even for one frame. The haversine
  // estimate reappears immediately (it's recomputed from `backbone` on every
  // render regardless) while RealDetours re-measures in the background.
  const [lastBackbone, setLastBackbone] = useState(backbone)
  if (lastBackbone !== backbone) {
    setLastBackbone(backbone)
    setRealDetours(new Map())
  }

  const locatedStops = useMemo(
    () =>
      highlights.regions.flatMap((region, regionIndex) =>
        region.candidateStops
          .map((stop, stopIndex) => ({ regionIndex, stopIndex, stop }))
          .filter(
            (
              entry,
            ): entry is {
              regionIndex: number
              stopIndex: number
              stop: LocatedStop
            } => hasLocation(entry.stop),
          ),
      ),
    [highlights.regions],
  )

  const detourCandidates = useMemo<DetourCandidate[]>(
    () =>
      locatedStops
        .filter((entry) => entry.stop.priority !== 'must-see')
        .map((entry) => ({
          regionIndex: entry.regionIndex,
          stopIndex: entry.stopIndex,
          point: { lat: entry.stop.lat, lng: entry.stop.lng },
        })),
    [locatedStops],
  )

  const updateRealDetour = useCallback((key: string, km: number) => {
    setRealDetours((prev) => new Map(prev).set(key, km))
  }, [])

  function getDetour(
    regionIndex: number,
    stopIndex: number,
    stop: HighlightCandidateStop,
  ): DetourEstimate {
    const estimate = describeDetour(stop, backbone)
    if (estimate.kind !== 'detour') return estimate
    const real = realDetours.get(`${regionIndex}-${stopIndex}`)
    return real === undefined ? estimate : { kind: 'detour', km: real, isEstimate: false }
  }

  const framedPoints = useMemo(
    () => [
      ...backbone,
      ...locatedStops.map((entry) => ({ lat: entry.stop.lat, lng: entry.stop.lng })),
    ],
    [backbone, locatedStops],
  )

  const selectedStopPoint = useMemo(() => {
    if (!selectedStop) return null
    const stop =
      highlights.regions[selectedStop.regionIndex]?.candidateStops[
        selectedStop.stopIndex
      ]
    return stop && hasLocation(stop) ? { lat: stop.lat, lng: stop.lng } : null
  }, [selectedStop, highlights.regions])

  function updateRegionStops(
    regionIndex: number,
    updater: (stops: HighlightCandidateStop[]) => HighlightCandidateStop[],
  ) {
    setHighlights((prev) => ({
      // A region a traveler has emptied out by removing every one of its
      // candidates is dropped entirely rather than kept as a hollow shell —
      // the server schema requires at least one candidate per region
      // (reported as: submitting after removing a whole region's stops
      // failed schema validation), and an empty region has nothing useful to
      // tell the outline phase anyway.
      regions: prev.regions
        .map((region, i) =>
          i === regionIndex
            ? { ...region, candidateStops: updater(region.candidateStops) }
            : region,
        )
        .filter((region) => region.candidateStops.length > 0),
    }))
  }

  function movePriority(regionIndex: number, stopIndex: number, delta: 1 | -1) {
    updateRegionStops(regionIndex, (stops) =>
      stops.map((stop, i) => {
        if (i !== stopIndex) return stop
        const tierIndex = PRIORITY_TIERS.indexOf(stop.priority)
        const nextTier = PRIORITY_TIERS[tierIndex + delta]
        return nextTier ? { ...stop, priority: nextTier } : stop
      }),
    )
  }

  function removeStop(regionIndex: number, stopIndex: number) {
    updateRegionStops(regionIndex, (stops) =>
      stops.filter((_, i) => i !== stopIndex),
    )
    // Candidates are identified positionally (regionIndex/stopIndex), not by
    // a stable id, so any removal can shift what a stale selection would
    // point at — clearing outright is what guarantees the pop-out, if one
    // reopens, is always for the stop it claims to be.
    setSelectedStop(null)
  }

  async function submit() {
    setSubmitting(true)
    setError(null)
    try {
      await addDoc(collection(db, 'planRequests'), {
        tripId,
        kind: 'continueFromHighlights',
        editedHighlights: highlights,
        ...(note.trim() ? { reviewNote: note.trim() } : {}),
        status: 'pending',
        createdAt: serverTimestamp(),
      })
    } catch (err) {
      console.error('Failed to submit continueFromHighlights request', err)
      setError('Could not continue generating right now — try again.')
      setSubmitting(false)
    }
  }

  const apiKey = import.meta.env.VITE_GOOGLE_MAPS_API_KEY as string | undefined

  return (
    <div data-testid="highlights-review-panel" className="card space-y-4 p-4">
      <p className="text-sm text-neutral-600 dark:text-neutral-300">
        Here's what stood out region by region, before dates and pacing come
        into it. The line is the route through the must-sees; everything else
        shows roughly what it would add to the drive. Promote, demote, or remove
        anything before generating the full route.
      </p>

      {/* Sticky rather than scrolling away with the rest of the card: on a
          phone the map and a comfortably-sized candidate list can't both fit
          on screen at once, and a popup big enough to hold the same details
          as the list row (tried first) doesn't fit either. Pinning the map
          and letting the list scroll underneath it — with a tap on either
          side driving the other, see PanToSelected / scrollToStop — keeps the
          map usable as a constant reference instead of it being one more
          thing competing for vertical space. */}
      <div
        data-testid="highlights-map"
        className="sticky top-0 z-10 h-72 overflow-hidden rounded-xl border border-neutral-200 bg-white sm:h-80 md:h-96 dark:border-neutral-800 dark:bg-neutral-900"
      >
        {apiKey ? (
          <GoogleMap
            defaultCenter={{ lat: startPoint.lat, lng: startPoint.lng }}
            defaultZoom={5}
            mapId="rv-highlights-review"
            disableDefaultUI
            gestureHandling="greedy"
          >
            <FitToPoints points={framedPoints} />
            <BackboneRoute
              backbone={backbone}
              onError={setRouteError}
              onRouted={setLegDistancesKm}
            />
            <RealDetours
              backbone={backbone}
              legDistancesKm={legDistancesKm}
              candidates={detourCandidates}
              onUpdate={updateRealDetour}
            />
            <PanToSelected target={selectedStopPoint} />

            <AdvancedMarker
              position={{ lat: startPoint.lat, lng: startPoint.lng }}
              title={`Start: ${startPoint.name}`}
            >
              <div className="flex h-7 items-center rounded-full border-2 border-white bg-neutral-900 px-2 text-xs font-semibold text-white shadow-md dark:border-neutral-900 dark:bg-white dark:text-neutral-900">
                Start
              </div>
            </AdvancedMarker>
            <AdvancedMarker
              position={{ lat: endPoint.lat, lng: endPoint.lng }}
              title={`Finish: ${endPoint.name}`}
            >
              <div className="flex h-7 items-center rounded-full border-2 border-white bg-neutral-900 px-2 text-xs font-semibold text-white shadow-md dark:border-neutral-900 dark:bg-white dark:text-neutral-900">
                Finish
              </div>
            </AdvancedMarker>

            {locatedStops.map(({ regionIndex, stopIndex, stop }) => {
              const isSelected =
                selectedStop?.regionIndex === regionIndex &&
                selectedStop.stopIndex === stopIndex
              return (
                <AdvancedMarker
                  key={`${regionIndex}-${stopIndex}`}
                  position={{ lat: stop.lat, lng: stop.lng }}
                  title={`${stop.town} — ${PRIORITY_LABEL[stop.priority]}`}
                  data-testid="highlights-candidate-marker"
                  onClick={() => {
                    setSelectedStop({ regionIndex, stopIndex })
                    scrollToStop(regionIndex, stopIndex)
                  }}
                >
                  <CandidateMarker stop={stop} selected={isSelected} />
                </AdvancedMarker>
              )
            })}
          </GoogleMap>
        ) : (
          <p className="p-4 text-sm text-neutral-500 dark:text-neutral-400">
            Set VITE_GOOGLE_MAPS_API_KEY to display the map.
          </p>
        )}
      </div>

      {routeError && (
        <p
          data-testid="highlights-route-error"
          className="text-xs text-amber-700 dark:text-amber-400"
        >
          Showing a straight line instead of the real route — the driving
          directions request failed ({routeError}).
        </p>
      )}

      {highlights.regions.map((region, regionIndex) => (
        <div
          key={regionIndex}
          data-testid={`highlights-region-${regionIndex}`}
          className="space-y-2"
        >
          <h3 className="font-medium text-neutral-900 dark:text-white">
            {region.region}
          </h3>
          <p className="text-xs text-neutral-500 dark:text-neutral-400">
            {region.reasoning}
          </p>
          <div className="space-y-1">
            {region.candidateStops.map((stop, stopIndex) => {
              const isSelected =
                selectedStop?.regionIndex === regionIndex &&
                selectedStop.stopIndex === stopIndex
              return (
                <div
                  key={stopIndex}
                  ref={(el) => {
                    const key = `${regionIndex}-${stopIndex}`
                    if (el) stopRowRefs.current.set(key, el)
                    else stopRowRefs.current.delete(key)
                  }}
                  data-testid={`highlights-stop-${regionIndex}-${stopIndex}`}
                  // scroll-mt- matches the sticky map's own height above (see
                  // highlights-map) so scrollToStop's scrollIntoView doesn't
                  // land a row half-hidden underneath it.
                  className={`flex scroll-mt-72 items-start gap-2 rounded-lg border bg-white p-2 text-sm transition hover:shadow-sm sm:scroll-mt-80 md:scroll-mt-96 dark:bg-neutral-900 ${
                    isSelected
                      ? 'border-orange-500 ring-2 ring-orange-500'
                      : 'border-neutral-200 dark:border-neutral-800'
                  }`}
                >
                  <CandidateDetails
                    stop={stop}
                    regionIndex={regionIndex}
                    stopIndex={stopIndex}
                    detour={getDetour(regionIndex, stopIndex, stop)}
                    onFocus={
                      hasLocation(stop)
                        ? () => setSelectedStop({ regionIndex, stopIndex })
                        : undefined
                    }
                    onRaise={() => movePriority(regionIndex, stopIndex, 1)}
                    onLower={() => movePriority(regionIndex, stopIndex, -1)}
                    onRemove={() => removeStop(regionIndex, stopIndex)}
                  />
                </div>
              )
            })}
          </div>
        </div>
      ))}

      <label className="block">
        <span className="field-label">
          Anything else to make sure gets included?
        </span>
        <textarea
          data-testid="highlights-review-note"
          className="field field-sm"
          placeholder="e.g. must include a waterfall stop"
          value={note}
          onChange={(event) => setNote(event.target.value)}
        />
      </label>

      {error && (
        <p
          data-testid="highlights-review-error"
          className="text-sm text-red-600 dark:text-red-400"
        >
          {error}
        </p>
      )}

      <button
        type="button"
        data-testid="highlights-review-continue"
        disabled={submitting}
        onClick={submit}
        className="btn btn-primary"
      >
        {submitting ? 'Continuing…' : 'Continue generating'}
      </button>
    </div>
  )
}
