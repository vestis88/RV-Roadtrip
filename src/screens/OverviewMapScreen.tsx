import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  AdvancedMarker,
  Map as GoogleMap,
  type MapCameraChangedEvent,
} from '@vis.gl/react-google-maps'
import type { Activity, LatLng } from '@rv/shared'
import { useTripContext } from '../context/TripContext'
import { useTripDays } from '../hooks/useTripDays'
import { useDayPlaces } from '../hooks/useDayPlaces'
import { useCorridorStops } from '../hooks/useCorridorStops'
import { buildOverviewRoutePoints } from '../lib/buildOverviewRoute'
import { getZoomTiers } from '../lib/mapZoomTiers'
import {
  CATEGORY_ICON,
  CORRIDOR_LOCKED_ICON,
  CORRIDOR_PROPOSED_ICON,
  OVERNIGHT_ICON,
  RESTAURANT_ICON,
} from '../lib/mapIcons'
import { isoCountryFlag } from '../lib/countryFlag'
import { useOnlineStatus } from '../hooks/useOnlineStatus'
import { submitPlanChangeRequest } from '../lib/submitChangeRequest'
import { usePlanBusy } from '../lib/planBusy'
import {
  rejectCorridorStop,
  setCorridorStopStatus,
} from '../lib/corridorStopActions'
import {
  setCandidatePriority,
  sortCandidatesForList,
} from '../lib/exploreCandidateActions'
import { MarkerBadge } from '../components/MarkerBadge'
import { ExploreCandidateCard } from '../components/ExploreCandidateCard'
import { AddCorridorStopForm } from '../components/AddCorridorStopForm'
import { RescanCorridorButton } from '../components/RescanCorridorButton'
import { SearchAreaCircle } from '../components/SearchAreaCircle'
import {
  RESCAN_RADIUS_KM,
  visibleRadiusKm,
} from '../lib/rescanCorridorAction'
import { ReorderCorridorPanel } from '../components/ReorderCorridorPanel'
import { DirectionsRoute } from '../components/DirectionsRoute'
import { MapPanner } from '../components/MapPanner'
import { ExploreMapScreen } from './ExploreMapScreen'

interface SelectedPlace {
  id: string
  name: string
  lat: number
  lng: number
}

/** Pans the map to whichever activity/restaurant marker was last tapped. */
export function OverviewMapScreen() {
  const { tripId, trip } = useTripContext()
  const navigate = useNavigate()
  const online = useOnlineStatus()
  const { days } = useTripDays(tripId)
  const { corridorStops } = useCorridorStops(tripId)
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
  const [center, setCenter] = useState<LatLng>({
    lat: trip.settings.startPoint.lat,
    lng: trip.settings.startPoint.lng,
  })
  const tiers = getZoomTiers(zoom)
  const dayIds = days.map((d) => d.id)
  // Fetched unconditionally, unlike the marker tiers below: the route threads
  // through each day's chosen or best-rated activity, so it needs every day's
  // places from load, not from whenever the traveler happens to zoom past 9.
  const places = useDayPlaces(tripId, dayIds, true)

  const [changeRequestOpen, setChangeRequestOpen] = useState(false)
  const [changeText, setChangeText] = useState('')
  const [lockedDayIds, setLockedDayIds] = useState<Set<string>>(new Set())
  const [routeError, setRouteError] = useState<string | null>(null)
  const [submittingChangeRequest, setSubmittingChangeRequest] = useState(false)
  const [changeRequestError, setChangeRequestError] = useState<string | null>(null)
  const [selectedPlace, setSelectedPlace] = useState<SelectedPlace | null>(null)
  const [selectedCorridorStopId, setSelectedCorridorStopId] = useState<
    string | null
  >(null)
  // committed stops are already represented by their day's own overnight
  // badge — this tier only ever shows the two kinds of stop that AREN'T
  // reconciled into a day yet: proposed (rescan finds) and locked
  // (traveler-pinned).
  // Rejected stops are excluded explicitly rather than by being absent: they
  // are kept in Firestore now (so a later refresh doesn't suggest them
  // again — see corridorStopStatusSchema), and "everything that isn't
  // committed" would otherwise start drawing a pin for every suggestion the
  // travelers have ever turned down.
  const editableCorridorStops = corridorStops.filter(
    (stop) => stop.status !== 'committed' && stop.status !== 'rejected',
  )
  // Everything still open to a decision, in the order the trip drives past
  // it — the same ordering the explore list uses, so a stop's neighbours in
  // the list are its neighbours on the road. Committed stops are in the day
  // sequence already and rejected ones are tombstones (see
  // corridorStopStatusSchema), so neither is something to decide about.
  const [consideredOpen, setConsideredOpen] = useState(true)
  const consideredRefs = useRef(new Map<string, HTMLDivElement>())
  const consideredStops = useMemo(
    () =>
      sortCandidatesForList(
        editableCorridorStops,
        trip.settings.startPoint,
        trip.settings.endPoint,
      ),
    [editableCorridorStops, trip.settings.startPoint, trip.settings.endPoint],
  )

  // Tapping a pin has to reach the card, which is below the map and often
  // below the fold — without this the selection ring lands off-screen and
  // the tap looks like it did nothing. Same behaviour the explore map has.
  useEffect(() => {
    if (!selectedCorridorStopId) return
    consideredRefs.current
      .get(selectedCorridorStopId)
      ?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }, [selectedCorridorStopId])

  /**
   * Selecting a stop opens the list as well as highlighting the card, since
   * a tap on a pin whose card is inside a collapsed section would otherwise
   * do nothing visible at all. Done here rather than in the effect above:
   * expanding is a consequence of the tap, not of the selection changing.
   */
  function selectCorridorStop(stopId: string) {
    setConsideredOpen(true)
    setSelectedCorridorStopId(stopId)
  }

  const [reorderOpen, setReorderOpen] = useState(false)
  // Committed stops in their current order — derived from each stop's
  // earliest linked day's index, since that's the real ordering key
  // (corridorStops itself carries no sequence field; linkedDayIds already
  // ties each stop back to real, already-ordered TripDays).
  const dayIndexById = new Map(days.map((day) => [day.id, day.index]))
  // Ordered by their days, so an empty `days` (the first render, before that
  // listener's first snapshot) can't produce an order at all — every stop
  // would tie on Infinity and fall back to whatever order Firestore happened
  // to return, which the reorder panel then snapshots into its own state.
  // Reported as an intermittent wrong first stop in that panel.
  const committedCorridorStops = (days.length === 0 ? [] : corridorStops)
    .filter((stop) => stop.status === 'committed')
    .map((stop) => ({
      id: stop.id,
      name: stop.name,
      earliestIndex: stop.linkedDayIds.reduce(
        (min, dayId) => Math.min(min, dayIndexById.get(dayId) ?? Infinity),
        Infinity,
      ),
    }))
    .sort((a, b) => a.earliestIndex - b.earliestIndex)
  // Locked stops with no linked day yet (a traveler-placed pin or a locked
  // rescan find) — these are the ones phase 4b's reconciliation can add into
  // the route; a 'proposed' stop must be locked first (ExploreCandidateCard
  // only offers "Add to route" once a stop is locked).
  const addableCorridorStops = corridorStops
    .filter((stop) => stop.status === 'locked' && stop.linkedDayIds.length === 0)
    .map((stop) => ({ id: stop.id, name: stop.name }))

  const planStatus = trip.planMeta.status
  // Same guard Day View now uses: a replan already in flight makes a second
  // request meaningless, and this button was tappable throughout one.
  const { busy: planBusy, markSubmitted: markPlanSubmitted } =
    usePlanBusy(planStatus)
  // Only a ready-ish plan has anything for the header stats/route/"Request
  // changes" to report on or act against — everything else (no plan yet,
  // mid-generation, failed) gets a status banner instead further down.
  const hasPlan = planStatus === 'ready' || planStatus === 'stale'

  // Advice about a trip that has back-loaded its driving (see the backend's
  // pacingWarnings()). Dismissal is keyed on the warnings themselves rather
  // than a boolean: the plan is still perfectly usable with them, so this
  // must not nag forever — but a regeneration that produces a *different*
  // set has something new to say and gets to say it.
  const pacingWarnings = trip.planMeta.pacingWarnings ?? []
  const pacingWarningKey = pacingWarnings.join('\n')
  const [dismissedPacingKey, setDismissedPacingKey] = useState<string | null>(
    null,
  )
  const showPacingWarnings =
    hasPlan &&
    pacingWarnings.length > 0 &&
    pacingWarningKey !== dismissedPacingKey

  function toggleLock(dayId: string) {
    setLockedDayIds((prev) => {
      const next = new Set(prev)
      if (next.has(dayId)) next.delete(dayId)
      else next.add(dayId)
      return next
    })
  }

  async function submitChangeRequest() {
    setChangeRequestError(null)
    // A replan is the expensive path; a blank request fires one with no
    // instructions at all, and a double-tap fired two.
    if (!changeText.trim()) {
      setChangeRequestError('Describe what you would like changed first.')
      return
    }
    setSubmittingChangeRequest(true)
    try {
      await submitPlanChangeRequest(
        tripId,
        trip,
        changeText,
        Array.from(lockedDayIds),
      )
      markPlanSubmitted()
      setChangeRequestOpen(false)
    } catch (error) {
      console.error('Failed to submit change request', error)
      setChangeRequestError('Could not send that request — please try again.')
    } finally {
      setSubmittingChangeRequest(false)
    }
  }

  // Recomputed from whatever the current fetch produced rather than snapshotted
  // once: selecting an activity on a day screen and coming back here remounts
  // this screen, re-reads the days' places, and the route moves to match.
  const routePoints = useMemo(
    () =>
      buildOverviewRoutePoints(
        days.map((day) => ({
          overnight: day.overnight,
          driveSlot: day.drive?.slot,
          activities: places[day.id]?.activities,
          restaurants: places[day.id]?.restaurants,
        })),
      ),
    [days, places],
  )

  const apiKey = import.meta.env.VITE_GOOGLE_MAPS_API_KEY as string | undefined

  // Explore mode (2026-07-30) replaces the old plain "No plan yet" banner.
  // Safe as an early return here specifically because every hook in this
  // component (useState/useTripDays/useCorridorStops/useDayPlaces/the
  // routePoints useMemo above) has already run by this line — none follow
  // it, so this doesn't violate rules of hooks. It just means routePoints
  // gets computed over empty days/places and discarded while idle.
  if (planStatus === 'idle') {
    return <ExploreMapScreen tripId={tripId} trip={trip} />
  }

  return (
    <div className="flex h-full w-full flex-col">
      {hasPlan && (
        <div
          className="surface flex flex-wrap items-center justify-center gap-x-2 gap-y-1 border-b border-neutral-200 px-3 py-2 text-sm dark:border-neutral-800"
          data-testid="map-header"
        >
          <span
            data-testid="header-total-km"
            className="chip chip-neutral px-3 py-1"
          >
            {(trip.planMeta.totalKm ?? 0).toFixed(0)} km
          </span>
          <span
            data-testid="header-avg-drive-minutes"
            className="chip chip-neutral px-3 py-1"
          >
            {(trip.planMeta.avgDriveMinutesPerDay ?? 0).toFixed(0)} min/day avg
          </span>
          <span
            data-testid="header-day-count"
            className="chip chip-accent px-3 py-1"
          >
            {days.length} days
          </span>
          <button
            type="button"
            data-testid="request-changes-button"
            className="btn btn-ghost disabled:opacity-40"
            disabled={planBusy}
            onClick={() => setChangeRequestOpen(true)}
          >
            {planBusy ? 'Updating…' : 'Request changes'}
          </button>
          {(committedCorridorStops.length > 1 ||
            addableCorridorStops.length > 0) && (
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
      )}

      {reorderOpen && (
        <ReorderCorridorPanel
          tripId={tripId}
          stops={committedCorridorStops}
          addableStops={addableCorridorStops}
          planBusy={planBusy}
          onSubmitted={markPlanSubmitted}
          onClose={() => setReorderOpen(false)}
        />
      )}

      {(planStatus === 'pending' || planStatus === 'generating') && (
        <p
          data-testid="map-generating-banner"
          className="border-b border-neutral-200 bg-white p-3 text-center text-sm text-neutral-600 dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-300"
        >
          {trip.planMeta.progressTotal
            ? `${trip.planMeta.progressCurrent ?? 0}/${trip.planMeta.progressTotal} days (${Math.round(
                ((trip.planMeta.progressCurrent ?? 0) / trip.planMeta.progressTotal) *
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

      {showPacingWarnings && (
        <div
          data-testid="pacing-warning-banner"
          className="border-b border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-100"
        >
          <ul className="list-disc space-y-1 pl-5">
            {pacingWarnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
          <button
            type="button"
            data-testid="dismiss-pacing-warning"
            className="btn btn-ghost mt-2 text-xs"
            onClick={() => setDismissedPacingKey(pacingWarningKey)}
          >
            Got it
          </button>
        </div>
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

      {routeError && (
        <p
          data-testid="route-error-banner"
          className="border-b border-amber-300 bg-amber-50 p-2 text-center text-xs text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-100"
        >
          Showing a straight line instead of the real route — the driving
          directions request failed ({routeError}).
        </p>
      )}

      {changeRequestOpen && (
        <div className="border-b border-neutral-200 bg-white p-4 dark:border-neutral-800 dark:bg-neutral-900">
          <textarea
            data-testid="change-request-text"
            className="field"
            placeholder="e.g. more beaches, skip big cities"
            value={changeText}
            onChange={(event) => setChangeText(event.target.value)}
          />
          <div className="mt-3 flex flex-wrap gap-2">
            {days.map((day) => (
              <label
                key={day.id}
                className="flex cursor-pointer items-center gap-1.5 rounded-full border border-neutral-300 px-3 py-1.5 text-sm text-neutral-700 transition hover:bg-neutral-100 dark:border-neutral-700 dark:text-neutral-200 dark:hover:bg-neutral-800"
                data-testid={`lock-toggle-${day.id}`}
              >
                <input
                  type="checkbox"
                  className="accent-orange-600"
                  checked={lockedDayIds.has(day.id)}
                  onChange={() => toggleLock(day.id)}
                />
                Lock day {day.index + 1}
              </label>
            ))}
          </div>
          <button
            type="button"
            data-testid="submit-change-request"
            className="btn btn-primary mt-3"
            disabled={submittingChangeRequest}
            onClick={() => void submitChangeRequest()}
          >
            {submittingChangeRequest ? 'Sending…' : 'Submit'}
          </button>
          {changeRequestError && (
            <p
              data-testid="change-request-error"
              className="mt-2 text-sm text-red-600"
            >
              {changeRequestError}
            </p>
          )}
        </div>
      )}

      {/* `flex-1` alone is `flex: 1 1 0%` — a basis of ZERO — so the moment a
        * tall sibling appeared below it (the stops list added 2026-08-19)
        * this map was starved to no height at all and only its absolutely
        * positioned children were left, floating over the list. Reported as
        * "now the map is gone". The floor is what makes the split safe;
        * flex-1 still lets it take the whole screen when there is no list. */}
      <div
        className="relative min-h-[260px] flex-1"
        data-testid="map-canvas"
      >
        {apiKey ? (
          <GoogleMap
            defaultCenter={{
              lat: trip.settings.startPoint.lat,
              lng: trip.settings.startPoint.lng,
            }}
            defaultZoom={zoom}
            mapId="rv-trip-overview"
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
            <DirectionsRoute points={routePoints} onError={setRouteError} />
            {/* Only while aiming. Drawn on every map all the time, it
                buried the pins under a boundary nobody had asked to see. */}
            {aimingSearch && (
              <SearchAreaCircle
                center={center}
                radiusKm={searchArea.radiusKm}
                capped={searchArea.cappedFrom !== undefined}
              />
            )}
            <MapPanner target={selectedPlace} />

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

            {tiers.showOvernightStops &&
              days.map((day) => (
                <AdvancedMarker
                  key={day.id}
                  position={{ lat: day.overnight.lat, lng: day.overnight.lng }}
                  title={`Day ${day.index + 1}: ${day.overnight.name} ${isoCountryFlag(day.overnight.country)}`}
                  data-testid={`day-badge-${day.id}`}
                  onClick={() => navigate(`/map/day/${day.id}`)}
                >
                  <div className="flex h-8 items-center justify-center gap-0.5 rounded-full border-2 border-white bg-emerald-700 px-2 text-xs font-semibold text-white shadow-md dark:border-neutral-900">
                    {OVERNIGHT_ICON} {day.index + 1}
                  </div>
                </AdvancedMarker>
              ))}

            {(tiers.showSelectedActivities || tiers.showAllPlaces) &&
              days.flatMap((day) => {
                const dayPlaces = places[day.id]
                if (!dayPlaces) return []
                const activities: Activity[] = tiers.showAllPlaces
                  ? dayPlaces.activities
                  : dayPlaces.activities.filter((a) => a.status === 'selected')
                return activities.map((activity, i) => {
                  const placeId = `${day.id}-activity-${i}`
                  return (
                    <AdvancedMarker
                      key={placeId}
                      position={{ lat: activity.lat, lng: activity.lng }}
                      title={activity.name}
                      data-testid="activity-marker"
                      onClick={() =>
                        setSelectedPlace({
                          id: placeId,
                          name: activity.name,
                          lat: activity.lat,
                          lng: activity.lng,
                        })
                      }
                    >
                      <MarkerBadge
                        icon={CATEGORY_ICON[activity.category]}
                        selected={activity.status === 'selected'}
                        highlighted={selectedPlace?.id === placeId}
                      />
                    </AdvancedMarker>
                  )
                })
              })}

            {tiers.showAllPlaces &&
              days.flatMap((day) => {
                const dayPlaces = places[day.id]
                if (!dayPlaces) return []
                return dayPlaces.restaurants.map((restaurant, i) => {
                  const placeId = `${day.id}-restaurant-${i}`
                  return (
                    <AdvancedMarker
                      key={placeId}
                      position={{ lat: restaurant.lat, lng: restaurant.lng }}
                      title={restaurant.name}
                      data-testid="restaurant-marker"
                      onClick={() =>
                        setSelectedPlace({
                          id: placeId,
                          name: restaurant.name,
                          lat: restaurant.lat,
                          lng: restaurant.lng,
                        })
                      }
                    >
                      <MarkerBadge
                        icon={RESTAURANT_ICON}
                        selected={restaurant.status === 'selected'}
                        highlighted={selectedPlace?.id === placeId}
                      />
                    </AdvancedMarker>
                  )
                })
              })}

            {tiers.showCorridorStops &&
              editableCorridorStops.map((stop) => (
                <AdvancedMarker
                  key={stop.id}
                  position={{ lat: stop.lat, lng: stop.lng }}
                  title={`${stop.name}${stop.country ? ` ${isoCountryFlag(stop.country)}` : ''}`}
                  data-testid={`corridor-stop-marker-${stop.id}`}
                  onClick={() => selectCorridorStop(stop.id)}
                >
                  <MarkerBadge
                    icon={
                      stop.status === 'locked'
                        ? CORRIDOR_LOCKED_ICON
                        : CORRIDOR_PROPOSED_ICON
                    }
                    highlighted={selectedCorridorStopId === stop.id}
                  />
                </AdvancedMarker>
              ))}
          </GoogleMap>
        ) : (
          <p className="p-4 text-neutral-500">
            Set VITE_GOOGLE_MAPS_API_KEY to display the map.
          </p>
        )}
        {selectedPlace && (
          <p
            data-testid="map-selected-caption"
            className="absolute bottom-3 left-3 rounded-full bg-white/95 px-3 py-1.5 text-xs font-medium text-neutral-900 shadow-md backdrop-blur-sm dark:bg-neutral-900/95 dark:text-white"
          >
            Showing: {selectedPlace.name}
          </p>
        )}

        {/* Plain forms/buttons, not GoogleMap children — they only need
            `center` (sourced from trip.settings, independent of apiKey), so
            unlike the marker tiers above they render with no Maps key too
            (this sandbox's own CI runs e2e with none set, same as every
            other Maps-JS-blocked screen's fallback-input pattern). On the
            right, not the left: Google's own map type (Satellit/Karta)
            control sits top-left by default and these used to sit right on
            top of it. */}
        <div className="absolute top-3 right-3 flex flex-col items-end gap-2">
          <AddCorridorStopForm tripId={tripId} defaultLocation={{ ...center, name: '' }} />
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

      {/* The overview, kept alive after the plan exists (2026-08-19).
        *
        * Reported as: "I'm not happy with how the overview is gone after the
        * plan is done... as we moved into detailed planning, the previously
        * researched thing just look boring and can only be removed, so the
        * whole functionality is gone." It was accurate. This screen had no
        * list at all — every curated stop existed only as a map pin whose
        * tap opened a card showing its name, its "why" and a Remove button,
        * because the card it opened gated "Lock in" on `proposed`, and
        * nothing curated in explore mode is `proposed`.
        *
        * So the same card the explore list uses is used here, and the two
        * screens now differ only in what a plan makes possible: an "Add to
        * route" button, and an "On route" badge for stops already reconciled
        * into a day. Interest levels, the photo, the sight's own
        * description, the base town, the time it needs and the Maps link all
        * survive into planning rather than being thrown away at the moment
        * the traveler starts using them.
        */}
      {consideredStops.length > 0 && (
        <div className="flex min-h-0 flex-col border-t border-neutral-200 dark:border-neutral-800">
          <button
            type="button"
            data-testid="considered-stops-toggle"
            onClick={() => setConsideredOpen((open) => !open)}
            className="flex w-full items-center justify-between p-3 text-left text-sm font-medium text-neutral-900 dark:text-white"
          >
            <span>
              Stops to consider ({consideredStops.length})
            </span>
            <span aria-hidden className="text-neutral-400">
              {consideredOpen ? '▾' : '▸'}
            </span>
          </button>
          {consideredOpen && (
            <div
              // Scrolls inside itself and stops at half the viewport, so a
              // twenty-four stop corridor cannot push the map off the
              // screen — the two halves are meant to be usable together.
              className="max-h-[50vh] min-h-0 space-y-2 overflow-y-auto p-3 pt-0"
              data-testid="considered-stops-list"
            >
              {consideredStops.map((stop) => (
                <ExploreCandidateCard
                  key={stop.id}
                  stop={stop}
                  // Straight-line detour needs a corridor to measure
                  // against; on a planned trip the real answer is the day a
                  // stop lands on, which "On route" already says.
                  detourKm={null}
                  onRoute={stop.linkedDayIds.length > 0}
                  highlighted={selectedCorridorStopId === stop.id}
                  innerRef={(element) => {
                    if (element) consideredRefs.current.set(stop.id, element)
                    else consideredRefs.current.delete(stop.id)
                  }}
                  onSelect={() => selectCorridorStop(stop.id)}
                  onSetPriority={(priority) =>
                    setCandidatePriority(tripId, stop.id, priority)
                  }
                  onLock={() => setCorridorStopStatus(tripId, stop.id, 'locked')}
                  onUnlock={() =>
                    setCorridorStopStatus(tripId, stop.id, 'candidate')
                  }
                  onReject={() => {
                    void rejectCorridorStop(tripId, stop.id)
                    setSelectedCorridorStopId(null)
                  }}
                  // Opens the panel that actually reconciles a stop into the
                  // day sequence — the same one "Edit route" opens, which
                  // already takes exactly this set as `addableStops`.
                  onAddToRoute={() => setReorderOpen(true)}
                />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

export default OverviewMapScreen
