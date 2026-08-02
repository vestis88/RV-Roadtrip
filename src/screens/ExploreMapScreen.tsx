import { useEffect, useMemo, useRef, useState } from 'react'
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
  deleteCorridorStop,
  setCorridorStopStatus,
} from '../lib/corridorStopActions'
import {
  TIER_ORDER,
  generateExploreHighlights,
  groupCandidatesByPriority,
  voteExploreCandidate,
} from '../lib/exploreCandidateActions'
import { isoCountryFlag } from '../lib/countryFlag'
import { CORRIDOR_CANDIDATE_ICON } from '../lib/mapIcons'
import { MarkerBadge } from '../components/MarkerBadge'
import { MapPanner } from '../components/MapPanner'
import { ExploreCandidateCard } from '../components/ExploreCandidateCard'
import { AddCorridorStopForm } from '../components/AddCorridorStopForm'
import { RescanCorridorButton } from '../components/RescanCorridorButton'
import { ConfirmGenerateDialog } from '../components/ConfirmGenerateDialog'
import { DirectionsRoute } from '../components/DirectionsRoute'
import { submitPlanRequest } from '../lib/submitPlanRequest'
import { hasRoute } from '../lib/validateRoute'

const TIER_LABEL: Record<CorridorStopPriority, string> = {
  'must-see': 'Must-see',
  'worth-a-detour': 'Worth a detour',
  'nice-if-convenient': 'Nice if convenient',
}

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
  const [routeError, setRouteError] = useState<string | null>(null)
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
  const grouped = useMemo(() => groupCandidatesByPriority(candidates), [candidates])

  // What the route is actually built through: everything explicitly kept
  // (`locked`) plus everything ranked must-see. Promoting a stop to must-see
  // therefore redraws the route through it immediately, and every other
  // candidate's detour is re-measured against that new shape — which is the
  // point of the tiers: a "worth a detour" stop that's 5km off a route
  // bending through the must-sees is a very different proposition from one
  // 200km off the bare start→end line. buildRouteBackbone sorts these along
  // the corridor itself, so promotion order never matters.
  const routeStops = useMemo(
    () => candidates.filter((c) => c.status === 'locked' || c.priority === 'must-see'),
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
      await generateExploreHighlights(tripId)
    } catch (error) {
      console.error('generateExploreHighlights failed', error)
      setGenError('Could not find stops right now — please try again.')
    } finally {
      setGenerating(false)
    }
  }

  function vote(stopId: string, direction: 'up' | 'down') {
    runStopAction(
      voteExploreCandidate(tripId, grouped, stopId, direction),
      'Could not reorder that stop — please try again.',
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
            <DirectionsRoute points={backbone} onError={setRouteError} />
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
                  selected={stop.status === 'locked'}
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
          <div className="space-y-4">
            {TIER_ORDER.filter((tier) => grouped[tier].length > 0).map((tier) => (
              <div key={tier} className="space-y-2">
                <h3 className="heading-sm text-sm text-neutral-500 dark:text-neutral-400">
                  {TIER_LABEL[tier]}
                </h3>
                <div className="space-y-2">
                  {grouped[tier].map((stop, i) => (
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
                      // A vote crosses tiers rather than stopping at a tier
                      // edge, so the only truly immovable positions are the
                      // very top and very bottom of the whole list.
                      canVoteUp={!(tier === TIER_ORDER[0] && i === 0)}
                      canVoteDown={
                        !(
                          tier === TIER_ORDER[TIER_ORDER.length - 1] &&
                          i === grouped[tier].length - 1
                        )
                      }
                      onSelect={() => setSelectedId(stop.id)}
                      onVoteUp={() => vote(stop.id, 'up')}
                      onVoteDown={() => vote(stop.id, 'down')}
                      onLock={() =>
                        runStopAction(
                          setCorridorStopStatus(tripId, stop.id, 'locked'),
                          'Could not keep that stop — please try again.',
                        )
                      }
                      onReject={() => {
                        runStopAction(
                          deleteCorridorStop(tripId, stop.id),
                          'Could not remove that stop — please try again.',
                        )
                        if (selectedId === stop.id) setSelectedId(null)
                      }}
                    />
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

export default ExploreMapScreen
