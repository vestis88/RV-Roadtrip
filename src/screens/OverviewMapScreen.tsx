import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  AdvancedMarker,
  Map as GoogleMap,
  Polyline,
  useMap,
  useMapsLibrary,
  type MapCameraChangedEvent,
} from '@vis.gl/react-google-maps'
import type { Activity, LatLng } from '@rv/shared'
import { useTripContext } from '../context/TripContext'
import { useTripDays } from '../hooks/useTripDays'
import { useDayPlaces } from '../hooks/useDayPlaces'
import {
  buildOverviewRoutePoints,
  chunkRouteSegments,
} from '../lib/buildOverviewRoute'
import { getZoomTiers } from '../lib/mapZoomTiers'
import { CATEGORY_ICON, OVERNIGHT_ICON, RESTAURANT_ICON } from '../lib/mapIcons'
import { isoCountryFlag } from '../lib/countryFlag'
import { useOnlineStatus } from '../hooks/useOnlineStatus'
import { submitPlanChangeRequest } from '../lib/submitChangeRequest'
import { MarkerBadge } from '../components/MarkerBadge'

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

interface SelectedPlace {
  id: string
  name: string
  lat: number
  lng: number
}

/** Pans the map to whichever activity/restaurant marker was last tapped. */
function MapPanner({ target }: { target: SelectedPlace | null }) {
  const map = useMap()
  useEffect(() => {
    if (map && target) map.panTo({ lat: target.lat, lng: target.lng })
  }, [map, target])
  return null
}

/**
 * The whole-trip driving route.
 *
 * Straight lines between overnight stops were the first version of this, and
 * they lie about the one thing this screen is for: a 60 km hop over a fjord or
 * an alpine pass reads identically to a 60 km motorway run, so the shape of the
 * trip on screen has nothing to do with the shape of the drive.
 *
 * The straight polyline survives as the fallback state rather than as a
 * separate error path — it renders immediately, the Directions results replace
 * it when they arrive, and if any segment fails (no key, quota, offline) it is
 * simply never replaced. A partially-routed map with a gap where one request
 * 403'd would be worse than a consistently approximate one.
 */
function TripRoute({
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
      console.warn('Overview route directions failed', error)
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

export function OverviewMapScreen() {
  const { tripId, trip } = useTripContext()
  const navigate = useNavigate()
  const online = useOnlineStatus()
  const { days } = useTripDays(tripId)
  const [zoom, setZoom] = useState(6)
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
  const [selectedPlace, setSelectedPlace] = useState<SelectedPlace | null>(null)

  const planStatus = trip.planMeta.status
  // Only a ready-ish plan has anything for the header stats/route/"Request
  // changes" to report on or act against — everything else (no plan yet,
  // mid-generation, failed) gets a status banner instead further down.
  const hasPlan = planStatus === 'ready' || planStatus === 'stale'

  function toggleLock(dayId: string) {
    setLockedDayIds((prev) => {
      const next = new Set(prev)
      if (next.has(dayId)) next.delete(dayId)
      else next.add(dayId)
      return next
    })
  }

  async function submitChangeRequest() {
    await submitPlanChangeRequest(
      tripId,
      trip,
      changeText,
      Array.from(lockedDayIds),
    )
    setChangeRequestOpen(false)
  }

  // Recomputed from whatever the current fetch produced rather than snapshotted
  // once: selecting an activity on a day screen and coming back here remounts
  // this screen, re-reads the days' places, and the route moves to match.
  const routePoints = useMemo(
    () =>
      buildOverviewRoutePoints(
        days.map((day) => ({
          overnight: day.overnight,
          activities: places[day.id]?.activities,
        })),
      ),
    [days, places],
  )

  const apiKey = import.meta.env.VITE_GOOGLE_MAPS_API_KEY as string | undefined

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
            className="btn btn-ghost"
            onClick={() => setChangeRequestOpen(true)}
          >
            Request changes
          </button>
        </div>
      )}

      {planStatus === 'idle' && (
        <p
          data-testid="map-idle-banner"
          className="border-b border-neutral-200 bg-white p-3 text-center text-sm text-neutral-600 dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-300"
        >
          No plan yet — head to Trip setup to generate one.
        </p>
      )}

      {(planStatus === 'pending' ||
        planStatus === 'generating' ||
        planStatus === 'awaiting-highlights-review') && (
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
            onClick={submitChangeRequest}
          >
            Submit
          </button>
        </div>
      )}

      <div className="relative flex-1" data-testid="map-canvas">
        {apiKey ? (
          <GoogleMap
            defaultCenter={{
              lat: trip.settings.startPoint.lat,
              lng: trip.settings.startPoint.lng,
            }}
            defaultZoom={zoom}
            mapId="rv-trip-overview"
            gestureHandling="greedy"
            onCameraChanged={(event: MapCameraChangedEvent) =>
              setZoom(event.detail.zoom)
            }
          >
            <TripRoute points={routePoints} onError={setRouteError} />
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
      </div>
    </div>
  )
}

export default OverviewMapScreen
