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
import { useCurrentPosition } from '../hooks/useCurrentPosition'
import {
  applyRouteOrder,
  isNewRouteOrder,
  manualRouteOrder,
  mayOptimize,
  routeOrderKey,
  type RouteOrder,
} from '../lib/routeOrder'
import {
  setCorridorStopStatus,
  saveRouteOrder,
} from '../lib/corridorStopActions'
import {
  GENERIC_STOPS_ERROR,
  candidatePriority,
  findStopOvernightOptions,
  setStopStay,
  describeEmptyCandidateList,
  describeEmptyCountries,
  describeExploreHighlightsError,
  exploreAttemptBaseline,
  exploreFailureMessage,
  generateExploreHighlights,
  setCandidatePriority,
} from '../lib/exploreCandidateActions'
import type { ExploreAttemptBaseline } from '../lib/exploreCandidateActions'
import { isoCountryFlag } from '../lib/countryFlag'
import { countryName } from '../lib/countries'
import {
  CORRIDOR_CANDIDATE_ICON,
  CORRIDOR_DONE_ICON,
  LIVE_FIND_ICON,
} from '../lib/mapIcons'
import { MarkerBadge } from '../components/MarkerBadge'
import { MapPanner } from '../components/MapPanner'
import { ExploreCandidateCard } from '../components/ExploreCandidateCard'
import { AddCorridorStopForm } from '../components/AddCorridorStopForm'
import { MapSearchPanel, type SearchAnchor } from '../components/MapSearchPanel'
import { addFindToTrip } from '../lib/addFind'
import { SearchFindCard } from '../components/SearchFindCard'
import type { LiveFind } from '../lib/liveSearch'
import { SearchAreaCircle } from '../components/SearchAreaCircle'
import { MAX_RESCAN_RADIUS_KM, RESCAN_RADIUS_KM, visibleRadiusKm } from '../lib/rescanCorridorAction'
import { ConfirmGenerateDialog } from '../components/ConfirmGenerateDialog'
import { PlanStrip } from '../components/PlanStrip'
import {
  DirectionsRoute,
  type RouteTotals,
  type RouteLeg,
} from '../components/DirectionsRoute'
import { submitPlanRequest } from '../lib/submitPlanRequest'
import { usePlanBusy } from '../lib/planBusy'
import { hasRoute } from '../lib/validateRoute'
import { formatDriveTime } from '../lib/formatDuration'
import { markStopDone, unmarkStopDone } from '../lib/placeStatus'
import { describeBudget, tripBudget } from '../lib/tripBudget'
import { MAX_DIRECTIONS_POINTS_PER_REQUEST } from '../lib/buildOverviewRoute'
import { planSkeleton, writeSkeletonDays } from '../lib/skeletonDays'
import { removeStopFromRoute } from '../lib/dayCleanup'
import { canEditRoute } from '../lib/routeEditing'
import { arrivalEstimates } from '../lib/arrivalEstimates'
import { orderCandidatesByRoute } from '../lib/candidateOrder'
import {
  CANDIDATE_FILTER_LABEL,
  CANDIDATE_FILTER_ORDER,
  countByFilter,
  filterCandidates,
  type CandidateFilter,
} from '../lib/candidateFilter'
import { quantisePosition, routeOriginFor } from '../lib/routeOrigin'
import { useNavigate } from 'react-router-dom'

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
  // Where we are, drawn rather than only measured — see useCurrentPosition.
  const { position: here } = useCurrentPosition()
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
  /**
   * An explicit radius, beside the viewport rather than instead of it.
   *
   * The viewport default was confirmed right ("No. It was right to limit at
   * 7 km"), so this adds a way to say a number without taking away
   * pinch-to-size. null means "follow what I can see", which stays the
   * default.
   */
  const [radiusOverrideKm, setRadiusOverrideKm] = useState<number | null>(null)
  const [searchAnchor, setSearchAnchor] = useState<SearchAnchor>('map')
  /** Ephemeral finds — see MapSearchPanel on why these are never written. */
  const [finds, setFinds] = useState<LiveFind[] | null>(null)
  const [addedFindNames, setAddedFindNames] = useState<Set<string>>(new Set())
  /** Which find's pin was tapped — the same idea as selectedId, for finds. */
  const [selectedFind, setSelectedFind] = useState<string | null>(null)
  const searchArea = useMemo(() => {
    const fromViewport = bounds
      ? visibleRadiusKm(bounds)
      : { radiusKm: RESCAN_RADIUS_KM }
    if (radiusOverrideKm === null) return fromViewport
    // The cap still applies to a typed number: it is the callable's, not the
    // viewport's — see MAX_RESCAN_RADIUS_KM.
    return radiusOverrideKm > MAX_RESCAN_RADIUS_KM
      ? { radiusKm: MAX_RESCAN_RADIUS_KM, cappedFrom: radiusOverrideKm }
      : { radiusKm: radiusOverrideKm }
  }, [bounds, radiusOverrideKm])
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
  // Every hop of the route, so the list can say what each stop costs to
  // reach. Same stable-identity discipline as the totals handler above —
  // DirectionsRoute lists this in a dependency array.
  const [routeLegs, setRouteLegs] = useState<RouteLeg[] | null>(null)
  const handleRouteLegs = useCallback(
    (legs: RouteLeg[] | null) => setRouteLegs(legs),
    [],
  )
  const navigate = useNavigate()
  const [changeRequestOpen, setChangeRequestOpen] = useState(false)
  const [morePlanActionsOpen, setMorePlanActionsOpen] = useState(false)
  const [rebuildOpen, setRebuildOpen] = useState(false)
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
  // A stop marked done leaves the ROUTE — see corridorStop.doneAt. That is
  // what makes the totals and the day budget read as what is LEFT rather
  // than what was planned, and it hands one of Google's 25 optimisable
  // waypoints back as the trip is travelled. The card stays in the list,
  // muted, because a trip that looks emptier the more of it you have done is
  // the wrong feedback.
  const lockedStops = useMemo(
    () => candidates.filter((c) => c.status === 'locked' && !c.doneAt),
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
        // A hand-made order is never overwritten by a reply. Without this
        // the override would appear to work until the map next refreshed.
        held?.manual || !isNewRouteOrder(held, orderKey, order)
          ? held
          : { key: orderKey, order },
      )
    },
    [orderKey],
  )
  /** Moves one stop by one place, and marks the order as the traveler's. */
  const moveStop = useCallback(
    (stopId: string, delta: -1 | 1) => {
      setRouteOrder((held) => {
        const applied = applyRouteOrder(guessedOrder, held, orderKey)
        const from = applied.findIndex((stop) => stop.id === stopId)
        const to = from + delta
        if (from < 0 || to < 0 || to >= applied.length) return held
        const next = [...applied]
        ;[next[from], next[to]] = [next[to], next[from]]
        // Expressed as positions in the GUESS, which is what applyRouteOrder
        // indexes into — not positions in the currently-shown order.
        const positions = next.map((stop) =>
          guessedOrder.findIndex((g) => g.id === stop.id),
        )
        return manualRouteOrder(orderKey, positions)
      })
    },
    [guessedOrder, orderKey],
  )
  /** Back to whatever Google makes of it. */
  const resetOrder = useCallback(() => setRouteOrder(null), [])

  // Beds found per stop, held here rather than written to the trip: they are
  // a lookup the traveler asked for, not a decision they made, and caching
  // them on the stop would go stale silently as sites open and close.
  const [sleepBusy, setSleepBusy] = useState<string | null>(null)
  const [sleepByStop, setSleepByStop] = useState<
    Record<string, { name: string; kind: string; why?: string }[]>
  >({})
  const findSleep = useCallback(
    (stopId: string) => {
      setSleepBusy(stopId)
      findStopOvernightOptions(tripId, stopId)
        .then((candidates) => {
          setSleepByStop((held) => ({
            ...held,
            [stopId]: candidates.map((candidate) => ({
              name: candidate.name,
              kind: candidate.type,
              why: candidate.description,
            })),
          }))
        })
        .catch((error: unknown) => {
          console.error('Finding somewhere to sleep failed', error)
          setActionError(
            describeExploreHighlightsError(error) === GENERIC_STOPS_ERROR
              ? 'Could not look for somewhere to sleep — please try again.'
              : describeExploreHighlightsError(error),
          )
        })
        .finally(() => setSleepBusy(null))
    },
    [tripId],
  )
  const routeStops = useMemo(
    () => applyRouteOrder(guessedOrder, routeOrder, orderKey),
    [guessedOrder, routeOrder, orderKey],
  )
  // What the kept stops cost in days — the number the traveler trims
  // against. Legs are the real driving times when Google has answered and
  // absent before that, which tripBudget handles rather than waiting.
  const budget = useMemo(
    () =>
      tripBudget({
        stops: routeStops,
        legs: routeLegs ?? [],
        startDate: trip.settings.startDate,
        endDate: trip.settings.endDate,
        maxDriveHoursPerDay: trip.settings.maxDriveHoursPerDay,
      }),
    [
      routeStops,
      routeLegs,
      trip.settings.startDate,
      trip.settings.endDate,
      trip.settings.maxDriveHoursPerDay,
    ],
  )
  /**
   * The drive INTO each kept stop, by stop id.
   *
   * The backbone is `[start, ...stops, end]`, and Google returns one leg per
   * gap in the order actually driven — which is what `routeStops` is, since
   * that is the guess reordered by the very `waypoint_order` these legs came
   * back with. So leg[i] is the drive arriving at routeStops[i].
   *
   * Attached per stop rather than rendered between cards, because the list
   * is sorted independently of the driving order: "what it costs to get
   * here" stays true wherever the card sits. Skipped entirely unless the
   * counts line up — a partial or chunk-mismatched result would otherwise
   * label each stop with its neighbour's drive, which is worse than saying
   * nothing.
   */
  const legIntoStop = useMemo(() => {
    const map = new Map<string, RouteLeg>()
    if (!routeLegs || routeLegs.length !== routeStops.length + 1) return map
    routeStops.forEach((stop, index) => map.set(stop.id, routeLegs[index]))
    return map
  }, [routeLegs, routeStops])
  /**
   * Days, kept in step with the board, for free.
   *
   * Requested alongside keeping the overview: sharing and the diary both
   * read the `days` collection, so both need days to EXIST — not to be
   * detailed. Everything a skeleton needs is already on this screen, so it
   * is written here rather than asked of a callable: no cold start, no
   * Claude, nothing to wait for. See skeletonDays for the guards, all of
   * which live in a pure function so this effect has no judgement of its
   * own.
   *
   * A ref keyed on what was written, not state: writing must not re-render,
   * and the snapshot that comes back from the write would otherwise re-enter
   * this effect and write again.
   */
  const skeletonWritten = useRef<string | null>(null)
  useEffect(() => {
    const decision = planSkeleton({
      stops: routeStops,
      legs: routeLegs ?? [],
      existingDays: days,
      settings: trip.settings,
      planMeta: trip.planMeta,
    })
    if (!decision.days) return
    const signature = decision.days
      .map((day) => `${day.date}:${day.overnight.name}:${day.type}`)
      .join('|')
    if (skeletonWritten.current === signature) return
    skeletonWritten.current = signature
    void writeSkeletonDays(tripId, decision.days).catch((error: unknown) => {
      console.error('Writing the day skeleton failed', error)
      // Cleared so a transient failure is retried on the next change rather
      // than leaving the trip permanently dayless.
      skeletonWritten.current = null
    })
  }, [tripId, routeStops, routeLegs, days, trip.settings, trip.planMeta])

  /**
   * Roughly when each kept stop is reached — see arrivalEstimates for why
   * the count starts from today once the trip is running, and why a
   * committed day beats the packing.
   */
  const arrivals = useMemo(
    () =>
      arrivalEstimates({
        routeStops,
        legs: routeLegs ?? [],
        days,
        startDate: trip.settings.startDate,
        maxDriveHoursPerDay: trip.settings.maxDriveHoursPerDay,
        today: new Date().toISOString().slice(0, 10),
      }),
    [
      routeStops,
      routeLegs,
      days,
      trip.settings.startDate,
      trip.settings.maxDriveHoursPerDay,
    ],
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
  /**
   * Where the route starts from: the van while the trip is running, the
   * trip's start point otherwise. See routeOrigin for the two gates and the
   * quantiser — the last of which is what keeps a watched GPS from firing a
   * Directions request per fix.
   *
   * The previous origin is held in a ref rather than state so that keeping
   * it costs no render: the whole point is that an unmoved van changes
   * nothing at all.
   */
  // The ROUNDED numbers, deliberately, and kept as two scalars rather than
  // an object: `here` is a fresh object on every GPS fix, so memoising on it
  // would recompute the origin — and so re-ask Directions — for a few metres
  // of drift. Two numbers that only change when the van crosses a grid cell
  // are exactly the dependency this needs.
  const cell = here ? quantisePosition(here) : null
  const cellLat = cell?.lat ?? null
  const cellLng = cell?.lng ?? null
  const origin = useMemo(
    () =>
      routeOriginFor({
        startPoint: trip.settings.startPoint,
        position:
          cellLat !== null && cellLng !== null
            ? { lat: cellLat, lng: cellLng }
            : null,
        startDate: trip.settings.startDate,
        endDate: trip.settings.endDate,
        today: new Date().toISOString().slice(0, 10),
      }),
    [
      trip.settings.startPoint,
      trip.settings.startDate,
      trip.settings.endDate,
      cellLat,
      cellLng,
    ],
  )
  const originPoint = origin.point

  // What is ASKED. Built from the guess and nothing else, so its identity
  // changes only when the locked stops themselves do. DirectionsRoute lists
  // its points in an effect dependency array; handing it the answer to its
  // own last question is what made the route thrash — see routeOrder.ts.
  const askedBackbone = useMemo(
    () =>
      routeBackboneFrom(
        originPoint,
        guessedOrder.map((s) => ({ lat: s.lat, lng: s.lng })),
        trip.settings.endPoint,
      ),
    [originPoint, trip.settings.endPoint, guessedOrder],
  )
  // What is TRUE, once Google has answered: the real driving order. Drawn by
  // the Directions renderer from its own optimized result, and used for
  // everything downstream — the corridor sent to the server, the names in a
  // search prompt — but never fed back into the request above.
  const backbone = useMemo(
    () =>
      routeBackboneFrom(
        originPoint,
        routeStops.map((s) => ({ lat: s.lat, lng: s.lng })),
        trip.settings.endPoint,
      ),
    [originPoint, trip.settings.endPoint, routeStops],
  )
  // Route order, not a projection onto the start→end line — see
  // orderCandidatesByRoute. Declared after `backbone` because it needs it.
  const orderedCandidates = useMemo(
    () =>
      orderCandidatesByRoute({
        candidates,
        routeStops,
        backbone,
        startPoint: trip.settings.startPoint,
        endPoint: trip.settings.endPoint,
      }),
    [
      candidates,
      routeStops,
      backbone,
      trip.settings.startPoint,
      trip.settings.endPoint,
    ],
  )
  /**
   * Which bucket of stops the list is showing.
   *
   * Requested 2026-08-25: "There should be a filter for the list below the
   * map. Selecting only locked in, only must see, only not locked in or all."
   *
   * This REPLACES the "Show done (N)" toggle rather than sitting beside it.
   * Done stops leave the planning list by request (2026-08-24), and having
   * two differently shaped controls for the same idea was one mechanism too
   * many — "Done" is simply one of the buckets now.
   *
   * A stop whose PIN is tapped renders whatever the filter says, because a
   * tap that highlights nothing looks like a broken map — and it is still
   * the only way back to Undo for a done stop.
   */
  const [listFilter, setListFilter] = useState<CandidateFilter>('all')
  const filterCounts = useMemo(() => countByFilter(candidates), [candidates])
  const listedCandidates = useMemo(
    () =>
      orderedCandidates.filter(
        (stop) =>
          selectedId === stop.id ||
          filterCandidates([stop], listFilter).length > 0,
      ),
    [orderedCandidates, listFilter, selectedId],
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

  // The same for a find's pin, which now selects too — a tap that highlights
  // a card 400px below the fold looks exactly like a tap that did nothing.
  const findRefs = useRef<Record<string, HTMLDivElement | null>>({})
  useEffect(() => {
    if (!selectedFind) return
    findRefs.current[selectedFind]?.scrollIntoView({
      block: 'nearest',
      behavior: 'smooth',
    })
  }, [selectedFind])

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
  /**
   * Saving one ephemeral find as an ordinary candidate.
   *
   * The find is RETIRED from the ephemeral list on success, and that is the
   * fix for a reported bug rather than tidiness: "results added to the map
   * are not possible to interact with, even though they have been added to
   * the trip." Both pins were being drawn at the same coordinates — the
   * search result and the new stop — and the search pin, which has no card
   * and nothing to open, sat on top of the real one. Removing it hands the
   * spot to a pin that does something.
   *
   * Optimistic, and rolled back on failure: the button has to answer the tap
   * at a lay-by, and a find that silently failed to save would be discovered
   * a week later.
   */
  async function saveFind(find: LiveFind) {
    setAddedFindNames((held) => new Set(held).add(find.name))
    try {
      await addFindToTrip(tripId, find)
      setFinds((current) =>
        current ? current.filter((f) => f.name !== find.name) : current,
      )
      if (selectedFind === find.name) setSelectedFind(null)
    } catch (error) {
      console.error('Adding a find failed', error)
      setAddedFindNames((held) => {
        const next = new Set(held)
        next.delete(find.name)
        return next
      })
      setActionError('Could not add that to the trip — please try again.')
    }
  }

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
          routeStops={routeStops}
          routeLegs={routeLegs ?? []}
          reorderOpen={reorderOpen}
          changeRequestOpen={changeRequestOpen}
          onChangeRequestOpenChange={setChangeRequestOpen}
          rebuildOpen={rebuildOpen}
          onRebuildOpenChange={setRebuildOpen}
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

      {/* Every action the board offers, on ONE row.
        *
        * Requested 2026-08-24 on an annotated screenshot — "put on same
        * row", "I need the top part of the page to be more compact". The
        * five actions used to be split across this screen's header and
        * PlanStrip's, which is precisely why they could never share a line;
        * PlanStrip has no header of its own now and the board owns which of
        * its panels is open.
        *
        * The two primary buttons are `btn-sm` (36px), reported 2026-08-24
        * as "unreasonably big" on an iPhone.
        *
        * That is below the 44px touch minimum, and worth stating rather than
        * hiding: an earlier pass here shrank every button on the row, the
        * suite caught it, and it was restored on the argument that
        * compactness should come from deleting rows instead. Two things
        * changed since. The rows ARE deleted now — the plan actions collapse
        * behind "More" — and 36px is what every other control on this screen
        * already is, from the interest chips to "We've done this", so 44px
        * here was the odd one out rather than the standard. The nav links
        * and the revealed plan actions keep the full height, and the e2e
        * suite still measures those.
        *
        * The notices moved OUT of this row and onto their own line below:
        * they are sentences, and a sentence in a row of pill buttons wraps
        * the row and undoes the compaction it was put there for. */}
      <div
        className="surface flex flex-wrap items-center justify-center gap-x-2 gap-y-1 border-b border-neutral-200 px-3 py-1.5 text-sm dark:border-neutral-800"
        data-testid="explore-header"
      >
        <button
          type="button"
          data-testid="explore-find-stops-button"
          className="btn btn-sm btn-primary"
          disabled={exploring}
          onClick={() => void runFindStops()}
        >
          {exploring ? (
            'Finding great stops…'
          ) : candidates.length > 0 ? (
            <>
              <span className="sm:hidden">Find stops</span>
              <span className="hidden sm:inline">Find more stops</span>
            </>
          ) : (
            'Find great stops'
          )}
        </button>
        <button
          type="button"
          data-testid="explore-generate-plan-button"
          className="btn btn-sm btn-secondary disabled:opacity-40"
          disabled={!canCommit || planBusy}
          onClick={() => setConfirmOpen(true)}
        >
          {planBusy ? (
            'Starting the full plan…'
          ) : (
            <>
              {/* The longest label on the row, and the one that pushes the
                * two primary buttons onto separate lines on a phone. */}
              <span className="sm:hidden">
                Full plan ({candidates.length})
              </span>
              <span className="hidden sm:inline">
                Generate full plan ({candidates.length} stop
                {candidates.length === 1 ? '' : 's'})
              </span>
            </>
          )}
        </button>
        {days.length > 0 && (
          <>
            {/* On a phone these three wrap the row twice over, which is what
              * left almost no room for the list below the map (reported
              * 2026-08-24 from an iPhone: "very limited for scrolling the
              * list at the bottom. The top should be further compacted").
              * Shown inline wherever they fit, behind "More" where they do
              * not — `sm:` rather than a measured breakpoint, so there is no
              * JS deciding layout and nothing to keep in sync. */}
            <button
              type="button"
              data-testid="more-plan-actions"
              className="btn btn-ghost sm:hidden"
              aria-expanded={morePlanActionsOpen}
              onClick={() => setMorePlanActionsOpen((open) => !open)}
            >
              {morePlanActionsOpen ? 'Less' : 'More'}
            </button>
            <div
              className={`${
                morePlanActionsOpen ? 'flex' : 'hidden'
              } w-full flex-wrap items-center justify-center gap-2 sm:flex sm:w-auto`}
            >
              <button
                type="button"
                data-testid="request-changes-button"
                className="btn btn-ghost disabled:opacity-40"
                disabled={planBusy}
                onClick={() => setChangeRequestOpen(true)}
              >
                {planBusy ? 'Updating…' : 'Request changes'}
              </button>
              {routeStops.length > 0 && (
                <button
                  type="button"
                  data-testid="rebuild-days-button"
                  className="btn btn-ghost disabled:opacity-40"
                  disabled={planBusy}
                  onClick={() => setRebuildOpen(true)}
                >
                  Rebuild day list
                </button>
              )}
              {canEditRoute(days, corridorStops) && (
                <button
                  type="button"
                  data-testid="reorder-stops-button"
                  className="btn btn-ghost disabled:opacity-40"
                  disabled={planBusy}
                  onClick={() => setReorderOpen(true)}
                >
                  {planBusy ? 'Updating the plan…' : 'Edit route'}
                </button>
              )}
            </div>
          </>
        )}
      </div>

      {(genError || genNotice || genSummary || actionError) && (
        <div
          className="surface border-b border-neutral-200 px-3 pb-1.5 text-center text-sm dark:border-neutral-800"
          data-testid="explore-notices"
        >
          {genError && (
            <p
              data-testid="explore-find-stops-error"
              className="text-red-600 dark:text-red-400"
            >
              {genError}
            </p>
          )}
          {!genError && genNotice && (
            <p
              data-testid="explore-find-stops-error"
              className={
                genNotice.tone === 'error'
                  ? 'text-red-600 dark:text-red-400'
                  : 'text-neutral-600 dark:text-neutral-300'
              }
            >
              {genNotice.message}
            </p>
          )}
          {genSummary && !genError && !genNotice && (
            <p
              data-testid="explore-find-stops-summary"
              className="text-neutral-600 dark:text-neutral-300"
            >
              {genSummary}
            </p>
          )}
          {actionError && (
            <p
              data-testid="explore-action-error"
              className="text-red-600 dark:text-red-400"
            >
              {actionError}
            </p>
          )}
        </div>
      )}

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

      {/* Every number about the trip, on ONE row.
        *
        * Requested 2026-08-24 on an annotated screenshot — "combine" drawn
        * around the header chips and the route totals, which sat three rows
        * apart with the day strip and two rows of buttons between them.
        *
        * WHAT WAS DROPPED, and why it is a fix rather than a trim.
        * `planMeta.totalKm` and `planMeta.avgDriveMinutesPerDay` were
        * written by the last full GENERATION. The driving time and distance
        * here are live, from the Directions call the map is already making.
        * Putting them side by side made the divergence unmissable — "3223 km
        * … 2281 km", "31 days … ~9 days" — because the generated pair goes
        * out of date the moment a stop is locked or unlocked, which is the
        * whole point of the board. Two numbers claiming to be the trip's
        * length is the same failure the packing note in tripBudget warns
        * about; the live ones are the ones that are true.
        *
        * The day COUNT survives, because it says something the budget does
        * not: how many days the itinerary currently HAS, against how many
        * the kept stops need.
        *
        * Hidden entirely rather than shown as zero when nothing is kept
        * yet: "0 h" reads as a finding about the route rather than the
        * absence of one. Shown as unknown when the requests failed, since a
        * partial sum is indistinguishable on screen from a real one. */}
      {(routeStops.length > 0 || days.length > 0) && (
        <p
          data-testid="explore-route-totals"
          className="surface flex flex-wrap items-center justify-center gap-x-2 gap-y-1 border-b border-neutral-200 px-3 py-1.5 text-center text-xs text-neutral-600 dark:border-neutral-800 dark:text-neutral-300"
        >
          {routeStops.length > 0 && (
            <span>
              {routeTotals ? (
                <>
                  <span className="font-medium text-neutral-900 dark:text-white">
                    {formatDriveTime(routeTotals.durationMin)}
                  </span>
                  {/* "driving" is the one word here that earns nothing: the
                    * figure beside a distance is obviously a drive, and on a
                    * phone it was part of what pushed this row onto a third
                    * line. */}
                  <span className="hidden sm:inline"> driving</span> ·{' '}
                  {Math.round(routeTotals.distanceKm)} km
                </>
              ) : (
                <span className="text-neutral-500 dark:text-neutral-400">
                  Driving time unavailable
                </span>
              )}
            </span>
          )}
          {routeStops.length > 0 && (
            <span data-testid="explore-trip-budget">
              {describeBudget(budget, routeStops.length)}
            </span>
          )}
          {/* Said out loud, because it silently changes every number on
            * this row. A single bad fix would otherwise rewrite the driving
            * total, the budget and the arrival dates with nothing on screen
            * explaining why — and no way to tell it from a routing bug. */}
          {origin.fromPosition && (
            <span
              data-testid="routing-from-position"
              className="chip chip-accent"
              title="Distances and dates are measured from where you are, not from the trip's start point"
            >
              <span className="sm:hidden">from here</span>
              <span className="hidden sm:inline">from where we are</span>
            </span>
          )}
          {days.length > 0 && (
            <span data-testid="header-day-count" className="chip chip-accent">
              {days.length} days
            </span>
          )}
          {routeOrder?.manual && (
            <button
              type="button"
              data-testid="reset-route-order"
              className="link"
              onClick={resetOrder}
            >
              Your order — reset to Google&rsquo;s
            </button>
          )}
          {!mayOptimize(routeOrder) ||
          askedBackbone.length <= MAX_DIRECTIONS_POINTS_PER_REQUEST ? null : (
            /* Google optimises only when the whole route fits one request.
             * Past that it silently drove them in the order given, with
             * nothing on screen saying so — see DirectionsRoute. */
            <span
              data-testid="too-many-to-optimise"
              className="text-neutral-500 dark:text-neutral-400"
            >
              too many stops for Google to optimise; using your order
            </span>
          )}
          {budget.spareDays < 0 && budget.daysAvailable > 0 && (
            <span
              data-testid="explore-budget-over"
              className="text-amber-700 dark:text-amber-300"
            >
              more than the dates allow
            </span>
          )}
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
                onLegs={handleRouteLegs}
                // Explore mode only. Nobody has committed to this order — it
                // is our own projection guess — so Google reordering it
                // against real roads is strictly better information. The
                // generated plan's route is NOT optimized: those points are
                // days with dates on them.
                optimizeOrder={mayOptimize(routeOrder)}
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
              {here && (
                <AdvancedMarker
                  position={{ lat: here.lat, lng: here.lng }}
                  title="You are here"
                >
                  <div
                    data-testid="current-position-marker"
                    className="h-4 w-4 rounded-full border-2 border-white bg-sky-600 shadow-md dark:border-neutral-900"
                  />
                </AdvancedMarker>
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
              {/* Ephemeral finds, drawn so the answer to "what's near us" is
                * a place on the map rather than a name in a list — the
                * whole reason this moved off its own tab (2026-08-24: "use
                * the map view, so it's easy to see the location of the
                * results"). Dashed and unnumbered, because nothing here is
                * part of the trip until it is added. */}
              {(finds ?? []).map((find) => (
                <AdvancedMarker
                  key={`find:${find.name}`}
                  position={{ lat: find.lat, lng: find.lng }}
                  title={find.name}
                  data-testid={`live-find-marker-${find.name}`}
                  // Reported 2026-08-25: "results added to the map are not
                  // possible to interact with." These pins had no onClick at
                  // all — they were decoration on a map whose every other
                  // pin opens something.
                  onClick={() => setSelectedFind(find.name)}
                >
                  <MarkerBadge
                    icon={LIVE_FIND_ICON}
                    highlighted={selectedFind === find.name}
                  />
                </AdvancedMarker>
              ))}
              {candidates.map((stop) => (
                <AdvancedMarker
                  key={stop.id}
                  position={{ lat: stop.lat, lng: stop.lng }}
                  title={`${stop.name}${stop.country ? ` ${isoCountryFlag(stop.country)}` : ''}`}
                  data-testid={`explore-marker-${stop.id}`}
                  onClick={() => setSelectedId(stop.id)}
                >
                  <MarkerBadge
                    icon={
                      stop.doneAt
                        ? CORRIDOR_DONE_ICON
                        : CORRIDOR_CANDIDATE_ICON
                    }
                    // Behind you. Once the card has left the list this pin
                    // is the only trace of a finished stop, and it has to
                    // look different from one still ahead — see
                    // CORRIDOR_DONE_ICON.
                    done={!!stop.doneAt}
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
            <MapSearchPanel
              tripId={tripId}
              mapCenter={center}
              position={here}
              planMeta={trip.planMeta}
              area={searchArea}
              anchor={searchAnchor}
              onAnchorChange={setSearchAnchor}
              radiusOverrideKm={radiusOverrideKm}
              onRadiusOverrideChange={setRadiusOverrideKm}
              armed={aimingSearch}
              onArmedChange={setAimingSearch}
              finds={finds}
              onFinds={setFinds}
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
              {/* Which stops to show. A bucket per chip, with its own count
                * from the same predicate that does the filtering — a chip
                * promising seven above a list of five is the disagreement
                * this codebase already learned about from the header and the
                * itinerary. Empty buckets are not offered: a chip reading
                * "Done (0)" is a control that can only disappoint. */}
              <div
                role="radiogroup"
                aria-label="Which stops to show"
                data-testid="candidate-filter"
                className="flex flex-wrap gap-1"
              >
                {CANDIDATE_FILTER_ORDER.filter(
                  (filter) => filter === 'all' || filterCounts[filter] > 0,
                ).map((filter) => (
                  <button
                    key={filter}
                    type="button"
                    role="radio"
                    aria-checked={listFilter === filter}
                    data-testid={`candidate-filter-${filter}`}
                    onClick={() => setListFilter(filter)}
                    className={`chip px-2.5 py-1 ${
                      listFilter === filter ? 'chip-accent' : 'chip-neutral'
                    }`}
                  >
                    {CANDIDATE_FILTER_LABEL[filter]} ({filterCounts[filter]})
                  </button>
                ))}
              </div>
              {listedCandidates.length === 0 && (
                <p
                  data-testid="candidate-filter-empty"
                  className="p-3 text-center text-sm text-neutral-500 dark:text-neutral-400"
                >
                  No stops match that filter.
                </p>
              )}
              {/* Search results first, and in the list rather than in the
                * map overlay — see SearchFindCard. They sit above the stops
                * because they are the answer to the question just asked. */}
              {(finds ?? []).map((find) => (
                <SearchFindCard
                  key={`find:${find.name}`}
                  find={find}
                  added={addedFindNames.has(find.name)}
                  highlighted={selectedFind === find.name}
                  innerRef={(element) => {
                    findRefs.current[find.name] = element
                  }}
                  onSelect={() =>
                    setSelectedFind((current) =>
                      current === find.name ? null : find.name,
                    )
                  }
                  onAdd={() => void saveFind(find)}
                />
              ))}
              {listedCandidates.map((stop) => (
                <div key={stop.id}>
                  {legIntoStop.has(stop.id) && (
                    <p
                      data-testid={`explore-leg-${stop.id}`}
                      className="px-1 pb-1 text-xs text-neutral-500 dark:text-neutral-400"
                    >
                      ↓ {Math.round(legIntoStop.get(stop.id)!.distanceKm)} km ·{' '}
                      {formatDriveTime(legIntoStop.get(stop.id)!.durationMin)}{' '}
                      to get here
                    </p>
                  )}
                  <ExploreCandidateCard
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
                        //
                        // Its DAY goes with it, though. Writing the status
                        // alone left the day standing (2026-08-24: "I've
                        // removed stops previously locked in… but the items
                        // are still in the day list") — see dayCleanup.
                        removeStopFromRoute({
                          tripId,
                          stop,
                          stops: corridorStops,
                          days,
                          startDate: trip.settings.startDate,
                          nextStatus: 'candidate',
                        }),
                        'Could not unlock that stop — please try again.',
                      )
                    }
                    onReject={() => {
                      runStopAction(
                        // Kept as a tombstone rather than deleted, so the next
                        // "Find more stops" doesn't hand it straight back —
                        // see rejectCorridorStop.
                        removeStopFromRoute({
                          tripId,
                          stop,
                          stops: corridorStops,
                          days,
                          startDate: trip.settings.startDate,
                          nextStatus: 'rejected',
                        }),
                        'Could not remove that stop — please try again.',
                      )
                      if (selectedId === stop.id) setSelectedId(null)
                    }}
                    onMarkDone={
                      stop.status === 'locked' && !stop.doneAt
                        ? (when, note) =>
                            runStopAction(
                              markStopDone(tripId, stop.id, when, note),
                              'Could not mark that done — please try again.',
                            )
                        : undefined
                    }
                    onUndoDone={
                      stop.doneAt
                        ? () =>
                            runStopAction(
                              unmarkStopDone(tripId, stop.id),
                              'Could not undo that — please try again.',
                            )
                        : undefined
                    }
                    arrival={arrivals.get(stop.id)}
                    // Only for a stop that is actually in the route: an
                    // unlocked candidate has no day because it has not been
                    // chosen, which is not a problem to solve.
                    onBuildDays={
                      // `days.length > 0` because the panel this opens lives
                      // in PlanStrip, which only renders once a plan has
                      // days — offering it before that would be a button
                      // that does nothing. With no days at all the skeleton
                      // writer is about to make some anyway, unprompted.
                      days.length > 0 &&
                      stop.status === 'locked' &&
                      (stop.linkedDayIds ?? []).length === 0
                        ? () => setRebuildOpen(true)
                        : undefined
                    }
                    onOpenDay={(() => {
                      // The first day this stop is on. A stop can span
                      // several (a basecamp), and the first is the one the
                      // traveler means by "its day" — the arrival.
                      const dayId = (stop.linkedDayIds ?? []).find((id) =>
                        days.some((day) => day.id === id),
                      )
                      return dayId
                        ? () => navigate(`/map/day/${dayId}`)
                        : undefined
                    })()}
                    onFindOvernight={
                      routeStopIds.has(stop.id)
                        ? () => findSleep(stop.id)
                        : undefined
                    }
                    findingOvernight={sleepBusy === stop.id}
                    overnightOptions={sleepByStop[stop.id]}
                    onMoveUp={
                      routeStopIds.has(stop.id)
                        ? () => moveStop(stop.id, -1)
                        : undefined
                    }
                    onMoveDown={
                      routeStopIds.has(stop.id)
                        ? () => moveStop(stop.id, 1)
                        : undefined
                    }
                    // Only on a kept stop: how long to stay somewhere you
                    // have not decided to visit is noise, and the budget
                    // counts kept stops only.
                    onSetStay={
                      routeStopIds.has(stop.id)
                        ? (stay) =>
                            runStopAction(
                              setStopStay(tripId, stop.id, stay),
                              'Could not save how long you are staying — please try again.',
                            )
                        : undefined
                    }
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
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

export default ExploreMapScreen
