import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  AdvancedMarker,
  Map as GoogleMap,
  type MapCameraChangedEvent,
} from '@vis.gl/react-google-maps'
import {
  routeBackboneFrom,
  sortAlongRoute,
  estimateDetourKm,
  type CorridorStopPriority,
  type LatLng,
  type Trip,
} from '@rv/shared'
import { useCorridorStops } from '../hooks/useCorridorStops'
import { useTripDays } from '../hooks/useTripDays'
import { useOnlineStatus } from '../hooks/useOnlineStatus'
import {
  applyRouteOrder,
  isNewRouteOrder,
  routeOrderKey,
  type RouteOrder,
} from '../lib/routeOrder'
import {
  rejectCorridorStop,
  setCorridorStopStatus,
  saveRouteOrder,
} from '../lib/corridorStopActions'
import {
  GENERIC_STOPS_ERROR,
  TIER_LABEL,
  TIER_ORDER,
  candidatePriority,
  describeEmptyCandidateList,
  describeEmptyCountries,
  describeExploreHighlightsError,
  exploreAttemptBaseline,
  exploreFailureMessage,
  generateExploreHighlights,
  setCandidatePriority,
  sortCandidatesForList,
} from '../lib/exploreCandidateActions'
import type { ExploreAttemptBaseline } from '../lib/exploreCandidateActions'
import { isoCountryFlag } from '../lib/countryFlag'
import { countryName } from '../lib/countries'
import { CORRIDOR_CANDIDATE_ICON, PRIORITY_PIN_CLASS } from '../lib/mapIcons'
import { MarkerBadge } from '../components/MarkerBadge'
import { MapPanner } from '../components/MapPanner'
import { ExploreCandidateCard } from '../components/ExploreCandidateCard'
import { AddCorridorStopForm } from '../components/AddCorridorStopForm'
import { RescanCorridorButton } from '../components/RescanCorridorButton'
import { SearchAreaCircle } from '../components/SearchAreaCircle'
import { RESCAN_RADIUS_KM, visibleRadiusKm } from '../lib/rescanCorridorAction'
import { ConfirmGenerateDialog } from '../components/ConfirmGenerateDialog'
import { PlanStrip } from '../components/PlanStrip'
import {
  DirectionsRoute,
  type RouteTotals,
} from '../components/DirectionsRoute'
import { submitPlanRequest } from '../lib/submitPlanRequest'
import { usePlanBusy } from '../lib/planBusy'
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
  // The board renders at every plan status now, so it is the thing that has
  // to know whether a plan exists — see PlanStrip.
  const { days } = useTripDays(tripId)
  const online = useOnlineStatus()
  const planStatus = trip.planMeta.status
  // Opened both from PlanStrip's "Edit route" and from a locked, unlinked
  // stop's own "Add to route" — see PlanStrip's note on why it lives here.
  const [reorderOpen, setReorderOpen] = useState(false)
  const [zoom, setZoom] = useState(6)
  // The visible map rectangle, so "Rescan this area" can search the area
  // the traveler is actually looking at rather than a fixed circle around
  // its centre. Undefined until the map reports its first camera change.
  const [bounds, setBounds] = useState<
    { north: number; south: number; east: number; west: number } | undefined
  >(undefined)

  // The circle "Rescan this area" will search, computed ONCE here so the same
  // number both draws it on the map and is sent to the server. It follows the
  // viewport, which makes the map itself the size control: pinch to zoom and
  // the search resizes with it. Falls back to a fixed circle only until the
  // map has reported a camera change, which in practice is immediately.
  // First tap on "Rescan this area" aims, second searches — see
  // RescanCorridorButton. Held here because the circle is drawn here.
  const [aimingSearch, setAimingSearch] = useState(false)
  const searchArea = useMemo(
    () => (bounds ? visibleRadiusKm(bounds) : { radiusKm: RESCAN_RADIUS_KM }),
    [bounds],
  )
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
  // Set when the call rejects without the server having said anything, to
  // the trip as it stood when it was fired — see exploreFailureMessage,
  // which turns it into what the trip itself says happened, at render time.
  const [genDisconnected, setGenDisconnected] =
    useState<ExploreAttemptBaseline | null>(null)
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
  // `committing` alone is not a guard: it clears the instant the planRequest
  // write resolves, and the trip stays 'idle' for the second or two before
  // generatePlan's trigger claims it — which is exactly this screen's
  // rendering condition, so "Generate full plan" comes straight back and a
  // second full generation can be confirmed. Same hole the 2026-08-13
  // overnight-picker incident went through, on the most expensive button in
  // the app. (ConfirmGenerateDialog's own ref guard only covers double-taps
  // *within* one open dialog.)
  const { busy: planBusy, markSubmitted } = usePlanBusy(trip.planMeta.status)
  // Same reasoning as SettingsScreen.tsx's own `exploring`: a generation
  // fired from Trip Setup and still running server-side must show as
  // "still working" here too, on a screen that never made that call
  // itself — otherwise "Find great stops" looks clickable, and clicking it
  // just throws the busy-guard's generic error instead of reflecting the
  // real in-progress state.
  const exploring = generating || trip.planMeta.exploreStatus === 'generating'
  // Resolved during render, not in the catch: the snapshot that says what
  // happened usually arrives after the promise rejects.
  const genNotice = exploreFailureMessage(genDisconnected, trip.planMeta)

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
  // to the top tier, or press "Lock in", either one bent the route. They
  // could also disagree, and the card only ever rendered one of them: a
  // must-see stop sat on the route wearing the blue ring but showed no
  // "Locked in" chip and still offered a "Lock in" button that changed
  // nothing visible when pressed.
  //
  // The two now mean different things. Votes are triage — how much the
  // traveler cares, which is what sorts the list. Locking in is the commitment,
  // and it is the only thing that moves the route. The order they were kept
  // in never matters: the route order is worked out below, and by Google
  // rather than by us.
  const lockedStops = useMemo(
    () => candidates.filter((c) => c.status === 'locked'),
    [candidates],
  )
  // The starting guess: each stop's position projected onto the straight
  // start→end line. It is only a guess — a scalar projection cannot know
  // that the Baltic is between two of these points, which is how a trip
  // ended up driving north through Sweden and around the Gulf of Bothnia to
  // reach Estonia. Google replaces it below, against real roads.
  const guessedOrder = useMemo(
    () =>
      sortAlongRoute(
        trip.settings.startPoint,
        trip.settings.endPoint,
        lockedStops,
        (stop) => ({ lat: stop.lat, lng: stop.lng }),
      ),
    [trip.settings.startPoint, trip.settings.endPoint, lockedStops],
  )
  // Keyed by which stops it describes: an order is a list of positions, and
  // applying yesterday's positions to a different set of stops would shuffle
  // them into nonsense. A changed set simply falls back to the guess until
  // Directions answers again.
  const [routeOrder, setRouteOrder] = useState<RouteOrder | null>(null)
  const orderKey = useMemo(() => routeOrderKey(guessedOrder), [guessedOrder])
  const handleOrder = useCallback(
    (order: number[]) => {
      // Only when it actually says something new. Google agreeing with the
      // order it was given is the steady state, and storing that agreement
      // would re-render, rebuild the arrays and ask again — see routeOrder.ts.
      setRouteOrder((held) =>
        isNewRouteOrder(held, orderKey, order)
          ? { key: orderKey, order }
          : held,
      )
    },
    [orderKey],
  )
  const routeStops = useMemo(
    () => applyRouteOrder(guessedOrder, routeOrder, orderKey),
    [guessedOrder, routeOrder, orderKey],
  )
  const routeStopIds = useMemo(
    () => new Set(routeStops.map((s) => s.id)),
    [routeStops],
  )
  // Persisted, not just held: pressing "Generate full plan" sends nothing
  // but a trip id, so an order kept only in this component would be gone by
  // the time the route phase needed it — see saveRouteOrder.
  useEffect(() => {
    if (routeStops.length < 2) return
    void saveRouteOrder(tripId, routeStops).catch((error: unknown) =>
      console.error('Saving the route order failed', error),
    )
  }, [tripId, routeStops])
  // What is ASKED. Built from the guess and nothing else, so its identity
  // changes only when the locked stops themselves do. DirectionsRoute lists
  // its points in an effect dependency array; handing it the answer to its
  // own last question is what made the route thrash — see routeOrder.ts.
  const askedBackbone = useMemo(
    () =>
      routeBackboneFrom(
        trip.settings.startPoint,
        guessedOrder.map((s) => ({ lat: s.lat, lng: s.lng })),
        trip.settings.endPoint,
      ),
    [trip.settings.startPoint, trip.settings.endPoint, guessedOrder],
  )
  // What is TRUE, once Google has answered: the real driving order. Drawn by
  // the Directions renderer from its own optimized result, and used for
  // everything downstream — the corridor sent to the server, the names in a
  // search prompt — but never fed back into the request above.
  const backbone = useMemo(
    () =>
      routeBackboneFrom(
        trip.settings.startPoint,
        routeStops.map((s) => ({ lat: s.lat, lng: s.lng })),
        trip.settings.endPoint,
      ),
    [trip.settings.startPoint, trip.settings.endPoint, routeStops],
  )
  // The same corridor the backbone describes, in words — so the search
  // prompt can say "along the route through Helsingør, Hillerød…" instead
  // of listing latitudes (see reverseGeocode.ts for what that cost).
  // routeStops is in route order, so these are named in the order they are
  // actually driven past.
  const waypointNames = useMemo(
    () =>
      [
        trip.settings.startPoint.name,
        // routeStops is already in route order, so no re-derivation by
        // coordinate lookup — which also stops two stops that happen to
        // share a coordinate collapsing onto the same index.
        ...routeStops.map((stop) => stop.name),
        trip.settings.endPoint.name,
      ].filter((name) => name.trim() !== ''),
    [trip.settings.startPoint.name, trip.settings.endPoint.name, routeStops],
  )

  const detourByStopId = useMemo(() => {
    const map = new Map<string, number>()
    for (const stop of candidates) {
      map.set(
        stop.id,
        estimateDetourKm({ lat: stop.lat, lng: stop.lng }, backbone),
      )
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
    setGenDisconnected(null)
    // See src/lib/validateRoute.ts's own doc comment: a blank start/finish
    // point still looks like a real (0, 0) coordinate downstream, so this
    // must be caught here rather than relying on the Claude call itself to
    // notice — it previously just returned zero stops with no explanation.
    if (!hasRoute(trip.settings)) {
      setGenError(
        'Set a start and finish point in Trip Setup first — pick each from the suggestions so we can place it on the map.',
      )
      return
    }
    setGenerating(true)
    const before = exploreAttemptBaseline(trip.planMeta)
    try {
      const { candidateCount, alreadyKnown, emptyCountries } =
        await generateExploreHighlights(tripId)
      const found =
        candidateCount > 0
          ? `Added ${candidateCount} new ${candidateCount === 1 ? 'find' : 'finds'}${
              alreadyKnown > 0
                ? ` — the other ${alreadyKnown} you already had`
                : ''
            }.`
          : alreadyKnown > 0
            ? `Nothing new this time — all ${alreadyKnown} suggestions are already on your list.`
            : 'Nothing new turned up along this route.'
      // A country picked in Trip Setup that produced nothing is news, not an
      // absence to leave the traveler to notice for themselves.
      const gaps = describeEmptyCountries(emptyCountries, countryName)
      setGenSummary(gaps ? `${found} ${gaps}` : found)
    } catch (error) {
      console.error('generateExploreHighlights failed', error)
      // A dead connection is not a failed search — see exploreFailureMessage.
      // Only a server that actually answered gets to put an error on screen;
      // everything else is decided from the trip during render, because the
      // snapshot that explains it usually lands after this rejection does.
      const described = describeExploreHighlightsError(error)
      if (described === GENERIC_STOPS_ERROR) setGenDisconnected(before)
      else setGenError(described)
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
      // Before the dialog closes, so the screen has already changed by the
      // time the confirm button disappears — see planBusy above.
      markSubmitted()
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
    <div
      className="flex h-full w-full flex-col"
      data-testid="explore-map-screen"
    >
      {/* What the day-by-day plan adds, when there is one — on the board
        * rather than instead of it. See PlanStrip's own note: the overview
        * was never lost to layout, it was lost to a single branch that made
        * this screen exist only while no plan did. */}
      {days.length > 0 && (
        <PlanStrip
          tripId={tripId}
          trip={trip}
          days={days}
          corridorStops={corridorStops}
          reorderOpen={reorderOpen}
          onReorderOpenChange={setReorderOpen}
        />
      )}

      {/* Plan status and connectivity, which belong to the TRIP rather than
        * to the day-by-day view that used to host them. They render at every
        * status and whether or not days exist — a generation in flight is
        * exactly the moment there are no days to report on yet. */}
      {(planStatus === 'pending' || planStatus === 'generating') && (
        <p
          data-testid="map-generating-banner"
          className="border-b border-neutral-200 bg-white p-3 text-center text-sm text-neutral-600 dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-300"
        >
          {trip.planMeta.progressTotal
            ? `${trip.planMeta.progressCurrent ?? 0}/${trip.planMeta.progressTotal} days (${Math.round(
                ((trip.planMeta.progressCurrent ?? 0) /
                  trip.planMeta.progressTotal) *
                  100,
              )}%)`
            : (trip.planMeta.progressLabel ?? 'Planning your route…')}
        </p>
      )}

      {planStatus === 'error' && (
        <p
          data-testid="map-error-banner"
          className="border-b border-red-300 bg-red-50 p-3 text-center text-sm text-red-700 dark:border-red-800 dark:bg-red-950 dark:text-red-300"
        >
          {trip.planMeta.error ?? 'Something went wrong generating this plan.'}
        </p>
      )}

      {!online && (
        <p
          data-testid="offline-banner"
          className="border-b border-amber-300 bg-amber-50 p-2 text-center text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-100"
        >
          You're offline — showing your last synced plan. Map tiles need a
          connection.
        </p>
      )}

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
          <p
            data-testid="explore-find-stops-error"
            className="text-sm text-red-600"
          >
            {genError}
          </p>
        )}
        {!genError && genNotice && (
          <p
            data-testid="explore-find-stops-error"
            className={
              genNotice.tone === 'error'
                ? 'text-sm text-red-600'
                : 'text-sm text-neutral-600 dark:text-neutral-300'
            }
          >
            {genNotice.message}
          </p>
        )}
        {genSummary && !genError && !genNotice && (
          <p
            data-testid="explore-find-stops-summary"
            className="text-sm text-neutral-600 dark:text-neutral-300"
          >
            {genSummary}
          </p>
        )}
        {actionError && (
          <p
            data-testid="explore-action-error"
            className="text-sm text-red-600"
          >
            {actionError}
          </p>
        )}
        <button
          type="button"
          data-testid="explore-generate-plan-button"
          className="btn btn-secondary disabled:opacity-40"
          disabled={!canCommit || planBusy}
          onClick={() => setConfirmOpen(true)}
        >
          {planBusy
            ? 'Starting the full plan…'
            : `Generate full plan (${candidates.length} stop${candidates.length === 1 ? '' : 's'})`}
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

      {/* Colour is only information if the reader is told what it means, and
       * the list is below the fold on a phone — so the key sits with the
       * map rather than with the cards. Only shown once there are pins to
       * explain. */}
      {candidates.length > 0 && (
        <p
          data-testid="explore-pin-legend"
          className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1 px-2 pb-1 text-xs text-neutral-500 dark:text-neutral-400"
        >
          {TIER_ORDER.map((tier) => (
            <span key={tier} className="flex items-center gap-1">
              <span
                className={`inline-block h-2.5 w-2.5 rounded-full border-2 ${PRIORITY_PIN_CLASS[tier]}`}
              />
              {TIER_LABEL[tier]}
            </span>
          ))}
        </p>
      )}

      {/* Side by side once there is room for it, stacked otherwise.
       * Requested 2026-08-22 for iPad landscape, where stacking wastes the
       * screen: a 45vh map over a list that scrolls in the remaining half,
       * on a display wide enough to show both at full height.
       *
       * `lg:landscape:` rather than `lg:` alone, because the 12.9" iPad is
       * 1024px wide in PORTRAIT too — wide enough for the breakpoint, and
       * the wrong shape for a split, since stacking is what suits a tall
       * screen. Orientation is the actual question; width only rules out
       * phones held sideways. DayViewScreen has had this split since the
       * beginning (`lg:flex-row`); these two screens never got it. */}
      <div className="flex min-h-0 flex-1 flex-col lg:landscape:flex-row">
        <div
          className="relative h-[45vh] min-h-[260px] lg:landscape:h-auto lg:landscape:flex-1"
          data-testid="explore-map-canvas"
        >
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
                // What "this area" means — see visibleRadiusKm. Stored as the
                // four numbers rather than the object, which arrives fresh
                // every frame of a drag.
                setBounds((prev) =>
                  prev &&
                  prev.north === event.detail.bounds.north &&
                  prev.south === event.detail.bounds.south &&
                  prev.east === event.detail.bounds.east &&
                  prev.west === event.detail.bounds.west
                    ? prev
                    : event.detail.bounds,
                )
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
                points={askedBackbone}
                onError={setRouteError}
                onTotals={handleRouteTotals}
                // Explore mode only. Nobody has committed to this order — it
                // is our own projection guess — so Google reordering it
                // against real roads is strictly better information. The
                // generated plan's route is NOT optimized: those points are
                // days with dates on them.
                optimizeOrder
                onOrder={handleOrder}
              />
              {/* Only while aiming. Drawn on every map all the time, it
                buried the pins under a boundary nobody had asked to see. */}
              {aimingSearch && (
                <SearchAreaCircle
                  center={center}
                  radiusKm={searchArea.radiusKm}
                  capped={searchArea.cappedFrom !== undefined}
                />
              )}
              <MapPanner
                target={
                  selected ? { lat: selected.lat, lng: selected.lng } : null
                }
              />
              <AdvancedMarker
                position={{
                  lat: trip.settings.startPoint.lat,
                  lng: trip.settings.startPoint.lng,
                }}
                title="Start"
              />
              <AdvancedMarker
                position={{
                  lat: trip.settings.endPoint.lat,
                  lng: trip.settings.endPoint.lng,
                }}
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
                    // Green/amber/red by interest level. Read straight off the
                    // stop through the same helper the card's selector uses,
                    // so a level changed on the card repaints the pin on the
                    // next snapshot with nothing to keep in sync — corridorStops
                    // is a live subscription and the write goes to the doc both
                    // of them render from.
                    priority={candidatePriority(stop)}
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
            <RescanCorridorButton
              tripId={tripId}
              center={center}
              area={searchArea}
              planMeta={trip.planMeta}
              armed={aimingSearch}
              onArmedChange={setAimingSearch}
            />
          </div>
        </div>

        <div
          // A fixed sidebar rather than a share of the width: these cards carry
          // a photo, a paragraph and four buttons, and they read the same at
          // every screen size instead of reflowing with the map.
          className="min-h-0 flex-1 overflow-y-auto p-3 lg:landscape:w-96 lg:landscape:flex-none lg:landscape:border-l lg:landscape:border-neutral-200 dark:lg:landscape:border-neutral-800"
          data-testid="explore-candidate-list"
        >
          {candidates.length === 0 ? (
            <p
              className="p-4 text-center text-sm text-neutral-500 dark:text-neutral-400"
              data-testid="explore-empty-state"
            >
              {describeEmptyCandidateList(trip.planMeta, countryName)}
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
                      'Could not lock in that stop — please try again.',
                    )
                  }
                  onUnlock={() =>
                    runStopAction(
                      // Straight back to 'candidate' — the stop keeps its
                      // interest level and its place in the list, and only
                      // stops bending the route. Nothing else about it changes,
                      // which is the whole difference between this and "Not
                      // interested".
                      setCorridorStopStatus(tripId, stop.id, 'candidate'),
                      'Could not unlock that stop — please try again.',
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
                  // Only where there is a route to add TO. A locked stop with
                  // no day yet is exactly what reconciliation can slot in —
                  // see the 2026-08-19 "real way into the route" work, which
                  // this board inherited when the plan stopped having a
                  // screen of its own.
                  onAddToRoute={
                    days.length > 0 &&
                    stop.status === 'locked' &&
                    stop.linkedDayIds.length === 0
                      ? () => setReorderOpen(true)
                      : undefined
                  }
                />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

export default ExploreMapScreen
