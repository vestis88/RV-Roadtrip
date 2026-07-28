import { useEffect, useMemo, useState } from 'react'
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
  hasLocation,
  type HighlightCandidateStop,
  type HighlightPriority,
  type HighlightRegion,
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
function BackboneRoute({ backbone }: { backbone: LatLng[] }) {
  const map = useMap()
  const routesLibrary = useMapsLibrary('routes')
  const [routedBackbone, setRoutedBackbone] = useState<LatLng[] | null>(null)

  useEffect(() => {
    if (!map || !routesLibrary || backbone.length < 2) return

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
      })
      .catch((error: unknown) => {
        console.warn('Highlights route directions failed', error)
      })

    return () => {
      cancelled = true
      renderer.setMap(null)
    }
  }, [map, routesLibrary, backbone])

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

function CandidateMarker({ stop }: { stop: HighlightCandidateStop }) {
  const mustSee = stop.priority === 'must-see'
  return (
    <div
      className={`flex h-7 items-center rounded-full border-2 border-white px-2 text-xs font-semibold shadow-md dark:border-neutral-900 ${
        mustSee
          ? 'bg-orange-600 text-white'
          : 'bg-white text-neutral-700 dark:bg-neutral-800 dark:text-neutral-200'
      }`}
    >
      {stop.town}
    </div>
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

  // Derived from live state, not from the pending highlights as loaded:
  // promoting a stop to must-see puts it INTO the backbone, which changes
  // what every other candidate's detour is measured against. Recomputing on
  // each edit is what makes the ▲/▼ buttons show their own consequences.
  const backbone = useMemo(
    () => buildIdealRouteBackbone(startPoint, highlights.regions, endPoint),
    [startPoint, highlights.regions, endPoint],
  )

  const locatedStops = useMemo(
    () =>
      highlights.regions.flatMap((region) =>
        region.candidateStops.filter(hasLocation),
      ),
    [highlights.regions],
  )

  const framedPoints = useMemo(
    () => [
      ...backbone,
      ...locatedStops.map((stop) => ({ lat: stop.lat, lng: stop.lng })),
    ],
    [backbone, locatedStops],
  )

  function updateRegionStops(
    regionIndex: number,
    updater: (stops: HighlightCandidateStop[]) => HighlightCandidateStop[],
  ) {
    setHighlights((prev) => ({
      regions: prev.regions.map((region, i) =>
        i === regionIndex
          ? { ...region, candidateStops: updater(region.candidateStops) }
          : region,
      ),
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

      <div
        data-testid="highlights-map"
        className="h-56 overflow-hidden rounded-xl border border-neutral-200 md:h-80 lg:h-96 dark:border-neutral-800"
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
            <BackboneRoute backbone={backbone} />

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

            {locatedStops.map((stop, i) => (
              <AdvancedMarker
                key={`${stop.town}-${i}`}
                position={{ lat: stop.lat, lng: stop.lng }}
                title={`${stop.town} — ${PRIORITY_LABEL[stop.priority]}`}
                data-testid="highlights-candidate-marker"
              >
                <CandidateMarker stop={stop} />
              </AdvancedMarker>
            ))}
          </GoogleMap>
        ) : (
          <p className="p-4 text-sm text-neutral-500 dark:text-neutral-400">
            Set VITE_GOOGLE_MAPS_API_KEY to display the map.
          </p>
        )}
      </div>

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
              const detour = describeDetour(stop, backbone)
              return (
                <div
                  key={stopIndex}
                  data-testid={`highlights-stop-${regionIndex}-${stopIndex}`}
                  className="flex items-start gap-2 rounded-lg border border-neutral-200 bg-white p-2 text-sm transition hover:shadow-sm dark:border-neutral-800 dark:bg-neutral-900"
                >
                  <div className="min-w-0 flex-1 space-y-1">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <p className="font-medium text-neutral-900 dark:text-white">
                        {stop.town}
                      </p>
                      <span
                        data-testid={`highlights-stop-priority-${regionIndex}-${stopIndex}`}
                        className="chip chip-neutral"
                      >
                        {PRIORITY_LABEL[stop.priority]}
                      </span>
                      {detour.kind !== 'unknown-location' && (
                        <span
                          data-testid={`highlights-stop-detour-${regionIndex}-${stopIndex}`}
                          className={
                            detour.kind === 'on-route'
                              ? 'chip chip-accent'
                              : 'chip chip-neutral'
                          }
                        >
                          {detour.kind === 'on-route'
                            ? 'On route'
                            : `≈+${Math.round(detour.km)} km detour`}
                        </span>
                      )}
                    </div>
                    {/* Deliberately not truncated: this description is the
                        whole reason the traveler can decide here instead of
                        going and looking the town up somewhere else. */}
                    <p className="text-xs text-neutral-500 dark:text-neutral-400">
                      {stop.why}
                    </p>
                  </div>
                  <div className="flex shrink-0 flex-col">
                    <button
                      type="button"
                      aria-label="Raise priority"
                      data-testid={`highlights-stop-up-${regionIndex}-${stopIndex}`}
                      disabled={stop.priority === 'must-see'}
                      onClick={() => movePriority(regionIndex, stopIndex, 1)}
                      className="px-1 text-xs text-neutral-500 disabled:opacity-30 dark:text-neutral-400"
                    >
                      ▲
                    </button>
                    <button
                      type="button"
                      aria-label="Lower priority"
                      data-testid={`highlights-stop-down-${regionIndex}-${stopIndex}`}
                      disabled={stop.priority === 'nice-if-convenient'}
                      onClick={() => movePriority(regionIndex, stopIndex, -1)}
                      className="px-1 text-xs text-neutral-500 disabled:opacity-30 dark:text-neutral-400"
                    >
                      ▼
                    </button>
                  </div>
                  <button
                    type="button"
                    data-testid={`highlights-stop-remove-${regionIndex}-${stopIndex}`}
                    onClick={() => removeStop(regionIndex, stopIndex)}
                    className="shrink-0 text-xs text-red-600 underline underline-offset-2 dark:text-red-400"
                  >
                    Remove
                  </button>
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
