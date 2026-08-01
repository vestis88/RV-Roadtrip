import { useMemo, useState } from 'react'
import {
  AdvancedMarker,
  Map as GoogleMap,
  useMap,
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
  generateExploreHighlights,
  groupCandidatesByPriority,
  voteExploreCandidate,
} from '../lib/exploreCandidateActions'
import { isoCountryFlag } from '../lib/countryFlag'
import { CORRIDOR_CANDIDATE_ICON } from '../lib/mapIcons'
import { MarkerBadge } from '../components/MarkerBadge'
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
const TIER_ORDER: CorridorStopPriority[] = [
  'must-see',
  'worth-a-detour',
  'nice-if-convenient',
]

/** Pans the map to whichever candidate was last selected, from either the
 * map itself or the list below it. */
function MapPanner({ target }: { target: LatLng | null }) {
  const map = useMap()
  if (map && target) map.panTo(target)
  return null
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
  // Same reasoning as SettingsScreen.tsx's own `exploring`: a generation
  // fired from Trip Setup and still running server-side must show as
  // "still working" here too, on a screen that never made that call
  // itself — otherwise "Find great stops" looks clickable, and clicking it
  // just throws the busy-guard's generic error instead of reflecting the
  // real in-progress state.
  const exploring = generating || trip.planMeta.exploreStatus === 'generating'

  const candidates = corridorStops.filter(
    (stop) => stop.status === 'candidate' || stop.status === 'locked',
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
  const lockedStops = candidates.filter((c) => c.status === 'locked')

  // Detour math (restored 2026-07-30 — see master_plan.md): the backbone
  // grows as candidates get locked in, so later detour estimates account
  // for stops already committed to, not just the raw start->end line.
  const backbone = useMemo(
    () =>
      buildRouteBackbone(
        trip.settings.startPoint,
        lockedStops.map((s) => ({ lat: s.lat, lng: s.lng })),
        trip.settings.endPoint,
      ),
    [trip.settings.startPoint, trip.settings.endPoint, lockedStops],
  )
  const detourByStopId = useMemo(() => {
    const map = new Map<string, number>()
    for (const stop of candidates) {
      map.set(stop.id, estimateDetourKm({ lat: stop.lat, lng: stop.lng }, backbone))
    }
    return map
  }, [candidates, backbone])

  const selected = candidates.find((c) => c.id === selectedId) ?? null

  async function runFindStops() {
    setGenError(null)
    // See src/lib/validateRoute.ts's own doc comment: a blank start/finish
    // point still looks like a real (0, 0) coordinate downstream, so this
    // must be caught here rather than relying on the Claude call itself to
    // notice — it previously just returned zero stops with no explanation.
    if (!hasRoute(trip.settings)) {
      setGenError('Set a start and finish point in Trip Setup first.')
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

  async function vote(tier: CorridorStopPriority, stopId: string, direction: 'up' | 'down') {
    await voteExploreCandidate(tripId, grouped[tier], stopId, direction)
  }

  async function commit() {
    setCommitting(true)
    try {
      await submitPlanRequest(tripId, 'fromExploreCandidates')
      setConfirmOpen(false)
    } finally {
      setCommitting(false)
    }
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
              setCenter(event.detail.center)
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
                      highlighted={selectedId === stop.id}
                      canVoteUp={i > 0}
                      canVoteDown={i < grouped[tier].length - 1}
                      onSelect={() => setSelectedId(stop.id)}
                      onVoteUp={() => void vote(tier, stop.id, 'up')}
                      onVoteDown={() => void vote(tier, stop.id, 'down')}
                      onLock={() => setCorridorStopStatus(tripId, stop.id, 'locked')}
                      onReject={() => {
                        deleteCorridorStop(tripId, stop.id)
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
