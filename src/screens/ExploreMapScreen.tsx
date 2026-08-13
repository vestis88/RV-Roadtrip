import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  AdvancedMarker,
  Map as GoogleMap,
  type MapCameraChangedEvent,
} from '@vis.gl/react-google-maps'
import {
  buildRouteBackbone,
  estimateDetourKm,
  type CorridorStopPriority,
  type LatLng,
  type Trip,
} from '@rv/shared'
import { useCorridorStops } from '../hooks/useCorridorStops'
import {
  rejectCorridorStop,
  setCorridorStopStatus,
} from '../lib/corridorStopActions'
import {
  describeExploreHighlightsError,
  generateExploreHighlights,
  setCandidatePriority,
  sortCandidatesForList,
} from '../lib/exploreCandidateActions'
import { isoCountryFlag } from '../lib/countryFlag'
import { CORRIDOR_CANDIDATE_ICON } from '../lib/mapIcons'
import { MarkerBadge } from '../components/MarkerBadge'
import { MapPanner } from '../components/MapPanner'
import { ExploreCandidateCard } from '../components/ExploreCandidateCard'
import { AddCorridorStopForm } from '../components/AddCorridorStopForm'
import { RescanCorridorButton } from '../components/RescanCorridorButton'
import { ConfirmGenerateDialog } from '../components/ConfirmGenerateDialog'
import { DirectionsRoute, type RouteTotals } from '../components/DirectionsRoute'
import { submitPlanRequest } from '../lib/submitPlanRequest'
import { hasRoute } from '../lib/validateRoute'
import { formatDriveTime } from '../lib/formatDuration'


interface ExploreMapScreenProps {
  tripId: string
  trip: Trip
}

/**
 * Explore mode (2026-07-30): what the Map tab shows before any plan exists
 * — a cheap, repeatable way to find and curate the stops worth building a
 * route around, without paying for a single day of full itinerary detail
 * until the traveler is actually ready to commit. See master_plan.md's
 * backlog entry for the full design/rationale (why `corridorStops` gained a
 * `candidate` status instead of a separate collection, why this replaces
 * the old one-shot highlights-review pause).
 */
export function ExploreMapScreen({ tripId, trip }: ExploreMapScreenProps) {
  const { corridorStops } = useCorridorStops(tripId)
  const [zoom, setZoom] = useState(6)
  // "Rescan this area"/"Add stop" both anchor to wherever the traveler is
  // actually looking, not a fixed point — OverviewMapScreen already tracks
  // this the same way; this screen previously didn't, so both actions
  // silently searched near the trip's start point regardless of how far
  // the map had been panned/zoomed away from it.
  const [center, setCenter] = useState<LatLng>({
    lat: trip.settings.startPoint.lat,
    lng: trip.settings.startPoint.lng,
  })
  const [generating, setGenerating] = useState(false)
  const [genError, setGenError] = useState<string | null>(null)
  // What the last refresh actually did. Worth saying out loud now that a
  // refresh merges: a run that finds ten sights the traveler already has
  // adds nothing to the list, and without a word from the app that is
  // indistinguishable from the button being broken.
  const [genSummary, setGenSummary] = useState<string | null>(null)
  const [routeError, setRouteError] = useState<string | null>(null)
  // Real driving totals for the kept-stop route, or null while unknown.
  // Stable identity via useCallback because DirectionsRoute lists this in
  // the dependency array of the effect that issues the requests — a fresh
  // function each render would re-fire every Directions call on every
  // render, which is both a bill and a rate limit.
  const [routeTotals, setRouteTotals] = useState<RouteTotals | null>(null)
  const handleRouteTotals = useCallback(
    (totals: RouteTotals | null) => setRouteTotals(totals),
    [],
  )
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [committing, setCommitting] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  // Same reasoning as SettingsScreen.tsx's own `exploring`: a generation
  // fired from Trip Setup and still running server-side must show as
  // "still working" here too, on a screen that never made that call
  // itself — otherwise "Find great stops" looks clickable, and clicking it
  // just throws the busy-guard's generic error instead of reflecting the
  // real in-progress state.
  const exploring = generating || trip.planMeta.exploreStatus === 'generating'

  // Memoised deliberately, and it matters far more than it looks: every
  // derived value below hangs off this array's IDENTITY. A bare .filter()
  // returns a new array on every render, so `routeStops` -> `backbone` all
  // recompute, `<DirectionsRoute points={backbone}>` sees new `points` in
  // its effect deps every render, re-requests directions, and setting the
  // result re-renders — which produces a fresh array again. That loop
  // sustains itself, fires a Google Directions request per iteration, and
  // leaves the map impossible to pan or zoom while it runs (reported as
  // the map freezing after promoting a stop, with the route never
  // updating — it was being cancelled and restarted continuously).
  const candidates = useMemo(
    () =>
      corridorStops.filter(
        (stop) => stop.status === 'candidate' || stop.status === 'locked',
      ),
    [corridorStops],
  )
  // Distinguishes "never searched" from "searched and genuinely found
  // nothing" for the empty-state message below — both look identical
  // otherwise (zero candidates), but a short/local trip legitimately
  // producing no highlights (see planTripPrompt.ts's own doc comment: "It
  // is fine — expected, even — for a short or local trip to have... no
  // regions with a genuine highlight") reads as broken without this.
  // Derived from trip.planMeta.exploreLastRunAt rather than local state —
  // the search that just ran might have been fired from SettingsScreen's
  // "Generate overview", which navigates here on success, mounting this
  // screen fresh with no memory of it.
  const searchedEmpty = candidates.length === 0 && !!trip.planMeta.exploreLastRunAt
  // Route order, not interest order: the list reads as the drive itself, so
  // a stop's neighbours in it are its neighbours on the map. Interest level
  // lives on each card instead (see ExploreCandidateCard).
  const orderedCandidates = useMemo(
    () =>
      sortCandidatesForList(
        candidates,
        trip.settings.startPoint,
        trip.settings.endPoint,
      ),
    [candidates, trip.settings.startPoint, trip.settings.endPoint],
  )

  // What the route is actually built through: everything explicitly kept
  // (`locked`), and nothing else.
  //
  // This used to also include everything ranked must-see, which gave the
  // traveler two unrelated controls that did the same thing — vote a stop up
  // to the top tier, or press "Keep this", either one bent the route. They
  // could also disagree, and the card only ever rendered one of them: a
  // must-see stop sat on the route wearing the blue ring but showed no
  // "Keeping" chip and still offered a "Keep this" button that changed
  // nothing visible when pressed.
  //
  // The two now mean different things. Votes are triage — how much the
  // traveler cares, which is what sorts the list. Keeping is the commitment,
  // and it is the only thing that moves the route. buildRouteBackbone sorts
  // these along the corridor itself, so the order they were kept in never
  // matters.
  const routeStops = useMemo(
    () => candidates.filter((c) => c.status === 'locked'),
    [candidates],
  )
  const routeStopIds = useMemo(
    () => new Set(routeStops.map((s) => s.id)),
    [routeStops],
  )
  const backbone = useMemo(
    () =>
      buildRouteBackbone(
        trip.settings.startPoint,
        routeStops.map((s) => ({ lat: s.lat, lng: s.lng })),
        trip.settings.endPoint,
      ),
    [trip.settings.startPoint, trip.settings.endPoint, routeStops],
  )
  // The same corridor the backbone describes, in words — so the search
  // prompt can say "along the route through Helsingør, Hillerød…" instead
  // of listing latitudes (see reverseGeocode.ts for what that cost).
  // buildRouteBackbone sorts its middle points along the corridor, so these
  // are named in geographic order too.
  const waypointNames = useMemo(
    () =>
      [
        trip.settings.startPoint.name,
        ...[...routeStops]
          .sort(
            (a, b) =>
              backbone.findIndex((p) => p.lat === a.lat && p.lng === a.lng) -
              backbone.findIndex((p) => p.lat === b.lat && p.lng === b.lng),
          )
          .map((stop) => stop.name),
        trip.settings.endPoint.name,
      ].filter((name) => name.trim() !== ''),
    [trip.settings.startPoint.name, trip.settings.endPoint.name, routeStops, backbone],
  )

  const detourByStopId = useMemo(() => {
    const map = new Map<string, number>()
    for (const stop of candidates) {
      map.set(stop.id, estimateDetourKm({ lat: stop.lat, lng: stop.lng }, backbone))
    }
    return map
  }, [candidates, backbone])

  // Tapping a map pin selects the stop, but its card can be anywhere in the
  // scrollable list below the fold — without this the highlight ring lands
  // off-screen and the tap looks like it did nothing.
  const cardRefs = useRef(new Map<string, HTMLDivElement>())
  useEffect(() => {
    if (!selectedId) return
    cardRefs.current
      .get(selectedId)
      ?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }, [selectedId])

  const selected = candidates.find((c) => c.id === selectedId) ?? null

  async function runFindStops() {
    setGenError(null)
    setGenSummary(null)
    // See src/lib/validateRoute.ts's own doc comment: a blank start/finish
    // point still looks like a real (0, 0) coordinate downstream, so this
    // must be caught here rather than relying on the Claude call itself to
    // notice — it previously just returned zero stops with no explanation.
    if (!hasRoute(trip.settings)) {
      setGenError('Set a start and finish point in Trip Setup first — pick each from the suggestions so we can place it on the map.')
      return
    }
    setGenerating(true)
    try {
      const { candidateCount, alreadyKnown } = await generateExploreHighlights(tripId)
      setGenSummary(
        candidateCount > 0
          ? `Added ${candidateCount} new ${candidateCount === 1 ? 'find' : 'finds'}${
              alreadyKnown > 0 ? ` — the other ${alreadyKnown} you already had` : ''
            }.`
          : alreadyKnown > 0
            ? `Nothing new this time — all ${alreadyKnown} suggestions are already on your list.`
            : 'Nothing new turned up along this route.',
      )
    } catch (error) {
      console.error('generateExploreHighlights failed', error)
      setGenError(describeExploreHighlightsError(error))
    } finally {
      setGenerating(false)
    }
  }

  function setInterest(stopId: string, priority: CorridorStopPriority) {
    runStopAction(
      setCandidatePriority(tripId, stopId, priority),
      'Could not change that stop — please try again.',
    )
  }

  async function commit() {
    setCommitting(true)
    try {
      await submitPlanRequest(tripId, 'fromExploreCandidates')
      setConfirmOpen(false)
    } catch (error) {
      // Without this the rejection was unhandled, the dialog stayed open
      // with no explanation, and the traveler had no way to tell a failed
      // submit from a slow one.
      console.error('submitPlanRequest failed', error)
      setGenError('Could not start the full plan — please try again.')
      setConfirmOpen(false)
    } finally {
      setCommitting(false)
    }
  }

  /**
   * Keep/Not-interested/Remove are plain Firestore writes that used to be
   * fired as floating promises — a permission-denied or offline write did
   * nothing at all and said nothing at all, while the card sat there
   * looking untouched.
   */
  function runStopAction(action: Promise<void>, failureMessage: string) {
    setActionError(null)
    action.catch((error: unknown) => {
      console.error(failureMessage, error)
      setActionError(failureMessage)
    })
  }

  const apiKey = import.meta.env.VITE_GOOGLE_MAPS_API_KEY as string | undefined
  const canCommit = candidates.length > 0

  return (
    <div className="flex h-full w-full flex-col" data-testid="explore-map-screen">
      <div
        className="surface flex flex-wrap items-center justify-center gap-2 border-b border-neutral-200 px-3 py-2 text-sm dark:border-neutral-800"
        data-testid="explore-header"
      >
        <button
          type="button"
          data-testid="explore-find-stops-button"
          className="btn btn-primary"
          disabled={exploring}
          onClick={() => void runFindStops()}
        >
          {exploring
            ? 'Finding great stops…'
            : candidates.length > 0
              ? 'Find more stops'
              : 'Find great stops'}
        </button>
        {genError && (
          <p data-testid="explore-find-stops-error" className="text-sm text-red-600">
            {genError}
          </p>
        )}
        {genSummary && !genError && (
          <p
            data-testid="explore-find-stops-summary"
            className="text-sm text-neutral-600 dark:text-neutral-300"
          >
            {genSummary}
          </p>
        )}
        {actionError && (
          <p data-testid="explore-action-error" className="text-sm text-red-600">
            {actionError}
          </p>
        )}
        <button
          type="button"
          data-testid="explore-generate-plan-button"
          className="btn btn-secondary"
          disabled={!canCommit}
          onClick={() => setConfirmOpen(true)}
        >
          Generate full plan ({candidates.length} stop{candidates.length === 1 ? '' : 's'})
        </button>
      </div>

      {confirmOpen && (
        <ConfirmGenerateDialog
          title="Generate the full day-by-day plan?"
          description="This fills in every day's route, activities, and restaurants from the stops you've curated — the expensive step. You can keep exploring and generate again later, but this is a full regeneration each time, not an incremental update."
          confirmLabel="Generate plan"
          submitting={committing}
          onConfirm={() => void commit()}
          onCancel={() => setConfirmOpen(false)}
        />
      )}

      {/* The drive the traveler has actually committed to so far: start →
        * every kept stop → finish. Real Directions figures, not the
        * straight-line estimate the per-candidate badges use, because the
        * Directions results were already being fetched to draw the route
        * line and every field except the geometry was being discarded — so
        * this costs no extra request.
        *
        * Hidden entirely rather than shown as zero when no stop is kept
        * yet: "0 h" would read as a finding about the route rather than the
        * absence of one. Shown as unknown when the requests failed, since a
        * partial sum is indistinguishable on screen from a real one. */}
      {routeStops.length > 0 && (
        <p
          data-testid="explore-route-totals"
          className="border-b border-neutral-200 px-3 py-1.5 text-center text-xs text-neutral-600 dark:border-neutral-800 dark:text-neutral-300"
        >
          {routeTotals ? (
            <>
              <span className="font-medium text-neutral-900 dark:text-white">
                {formatDriveTime(routeTotals.durationMin)}
              </span>{' '}
              driving · {Math.round(routeTotals.distanceKm)} km
            </>
          ) : (
            <span className="text-neutral-500 dark:text-neutral-400">
              Driving time unavailable
            </span>
          )}{' '}
          through {routeStops.length} kept stop
          {routeStops.length === 1 ? '' : 's'}
        </p>
      )}

      {routeError && (
        <p
          data-testid="explore-route-error-banner"
          className="border-b border-amber-300 bg-amber-50 p-2 text-center text-xs text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-100"
        >
          Showing a straight line instead of the real route — the driving
          directions request failed ({routeError}).
        </p>
      )}

      <div className="relative" style={{ height: '45vh', minHeight: '260px' }} data-testid="explore-map-canvas">
        {apiKey ? (
          <GoogleMap
            defaultCenter={{
              lat: trip.settings.startPoint.lat,
              lng: trip.settings.startPoint.lng,
            }}
            defaultZoom={zoom}
            mapId="rv-trip-explore"
            gestureHandling="greedy"
            onCameraChanged={(event: MapCameraChangedEvent) => {
              setZoom(event.detail.zoom)
              // Fires every frame of a drag, and the centre arrives as a
              // fresh object each time — storing it unconditionally
              // re-rendered this whole screen (map + candidate list) per
              // frame. Only the value matters here (it anchors "Rescan this
              // area"/"Add stop"), so ignore no-op updates.
              setCenter((prev) =>
                prev.lat === event.detail.center.lat &&
                prev.lng === event.detail.center.lng
                  ? prev
                  : event.detail.center,
              )
            }}
          >
            <DirectionsRoute
              points={backbone}
              onError={setRouteError}
              onTotals={handleRouteTotals}
            />
            <MapPanner target={selected ? { lat: selected.lat, lng: selected.lng } : null} />
            <AdvancedMarker
              position={{ lat: trip.settings.startPoint.lat, lng: trip.settings.startPoint.lng }}
              title="Start"
            />
            <AdvancedMarker
              position={{ lat: trip.settings.endPoint.lat, lng: trip.settings.endPoint.lng }}
              title="Finish"
            />
            {candidates.map((stop) => (
              <AdvancedMarker
                key={stop.id}
                position={{ lat: stop.lat, lng: stop.lng }}
                title={`${stop.name}${stop.country ? ` ${isoCountryFlag(stop.country)}` : ''}`}
                data-testid={`explore-marker-${stop.id}`}
                onClick={() => setSelectedId(stop.id)}
              >
                <MarkerBadge
                  icon={CORRIDOR_CANDIDATE_ICON}
                  // Blue = "this one is in my route" — exactly the kept
                  // (`locked`) stops buildRouteBackbone is drawn through
                  // (routeStopIds), so the pin, the card and the route line
                  // can never disagree about which stops are in.
                  selected={routeStopIds.has(stop.id)}
                  highlighted={selectedId === stop.id}
                />
              </AdvancedMarker>
            ))}
          </GoogleMap>
        ) : (
          <p className="p-4 text-neutral-500">
            Set VITE_GOOGLE_MAPS_API_KEY to display the map.
          </p>
        )}

        <div className="absolute top-3 right-3 flex flex-col items-end gap-2">
          <AddCorridorStopForm
            tripId={tripId}
            defaultLocation={{ ...center, name: '' }}
            backbone={backbone}
            waypointNames={waypointNames}
          />
          <RescanCorridorButton tripId={tripId} center={center} />
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-3" data-testid="explore-candidate-list">
        {candidates.length === 0 ? (
          <p
            className="p-4 text-center text-sm text-neutral-500 dark:text-neutral-400"
            data-testid="explore-empty-state"
          >
            {searchedEmpty
              ? 'Nothing stood out along this route — for a short or local trip, that can be the honest answer. Try "Rescan this area," describe what you\'re looking for with "Add stop," or drop a pin yourself.'
              : 'No stops yet — tap "Find great stops" to get suggestions for your route, or drop a pin / rescan an area on the map above.'}
          </p>
        ) : (
          <div className="space-y-2">
            {orderedCandidates.map((stop) => (
              <ExploreCandidateCard
                key={stop.id}
                stop={stop}
                detourKm={detourByStopId.get(stop.id) ?? null}
                onRoute={routeStopIds.has(stop.id)}
                highlighted={selectedId === stop.id}
                innerRef={(element) => {
                  if (element) cardRefs.current.set(stop.id, element)
                  else cardRefs.current.delete(stop.id)
                }}
                onSelect={() => setSelectedId(stop.id)}
                onSetPriority={(priority) => setInterest(stop.id, priority)}
                onLock={() =>
                  runStopAction(
                    setCorridorStopStatus(tripId, stop.id, 'locked'),
                    'Could not keep that stop — please try again.',
                  )
                }
                onReject={() => {
                  runStopAction(
                    // Kept as a tombstone rather than deleted, so the next
                    // "Find more stops" doesn't hand it straight back —
                    // see rejectCorridorStop.
                    rejectCorridorStop(tripId, stop.id),
                    'Could not remove that stop — please try again.',
                  )
                  if (selectedId === stop.id) setSelectedId(null)
                }}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

export default ExploreMapScreen
