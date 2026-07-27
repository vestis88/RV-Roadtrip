import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  AdvancedMarker,
  Map as GoogleMap,
  Polyline,
  type MapCameraChangedEvent,
} from '@vis.gl/react-google-maps'
import type { Activity } from '@rv/shared'
import { useTripContext } from '../context/TripContext'
import { useTripDays } from '../hooks/useTripDays'
import { useDayPlaces } from '../hooks/useDayPlaces'
import { getZoomTiers } from '../lib/mapZoomTiers'
import { CATEGORY_ICON, OVERNIGHT_ICON, RESTAURANT_ICON } from '../lib/mapIcons'
import { isoCountryFlag } from '../lib/countryFlag'
import { useOnlineStatus } from '../hooks/useOnlineStatus'
import { submitPlanChangeRequest } from '../lib/submitChangeRequest'
import { MarkerBadge } from '../components/MarkerBadge'

export function OverviewMapScreen() {
  const { tripId, trip } = useTripContext()
  const navigate = useNavigate()
  const online = useOnlineStatus()
  const { days } = useTripDays(tripId)
  const [zoom, setZoom] = useState(6)
  const tiers = getZoomTiers(zoom)
  const dayIds = days.map((d) => d.id)
  const places = useDayPlaces(
    tripId,
    dayIds,
    tiers.showSelectedActivities || tiers.showAllPlaces,
  )

  const [changeRequestOpen, setChangeRequestOpen] = useState(false)
  const [changeText, setChangeText] = useState('')
  const [lockedDayIds, setLockedDayIds] = useState<Set<string>>(new Set())

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

  const path = days
    .filter((d) => d.drive)
    .flatMap((d) => [
      { lat: d.overnight.lat, lng: d.overnight.lng },
    ])

  const apiKey = import.meta.env.VITE_GOOGLE_MAPS_API_KEY as string | undefined

  return (
    <div className="flex h-full w-full flex-col">
      <div
        className="flex justify-center gap-6 border-y border-neutral-200 bg-neutral-50 py-2 text-sm dark:border-neutral-800 dark:bg-neutral-950"
        data-testid="map-header"
      >
        <span data-testid="header-total-km">
          {(trip.planMeta.totalKm ?? 0).toFixed(0)} km
        </span>
        <span data-testid="header-avg-drive-minutes">
          {(trip.planMeta.avgDriveMinutesPerDay ?? 0).toFixed(0)} min/day avg
        </span>
        <span data-testid="header-day-count">{days.length} days</span>
        <button
          type="button"
          data-testid="request-changes-button"
          className="inline-flex min-h-11 items-center text-orange-700 underline dark:text-orange-400"
          onClick={() => setChangeRequestOpen(true)}
        >
          Request changes
        </button>
      </div>

      {!online && (
        <p
          data-testid="offline-banner"
          className="border-b border-amber-300 bg-amber-50 p-2 text-center text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-100"
        >
          You're offline — showing your last synced plan. Map tiles need a
          connection.
        </p>
      )}

      {changeRequestOpen && (
        <div className="border-b border-neutral-200 bg-white p-4 dark:border-neutral-800 dark:bg-neutral-900">
          <textarea
            data-testid="change-request-text"
            className="w-full rounded border border-neutral-300 p-2 dark:border-neutral-700 dark:bg-neutral-800 dark:text-white"
            placeholder="e.g. more beaches, skip big cities"
            value={changeText}
            onChange={(event) => setChangeText(event.target.value)}
          />
          <div className="mt-2 flex flex-wrap gap-2">
            {days.map((day) => (
              <label
                key={day.id}
                className="flex items-center gap-1 text-sm text-neutral-900 dark:text-white"
                data-testid={`lock-toggle-${day.id}`}
              >
                <input
                  type="checkbox"
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
            className="mt-2 rounded bg-orange-600 px-4 py-2 text-white"
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
            onCameraChanged={(event: MapCameraChangedEvent) =>
              setZoom(event.detail.zoom)
            }
          >
            {path.length > 1 && (
              <Polyline
                path={path}
                strokeColor="#ea580c"
                strokeOpacity={0.8}
                strokeWeight={4}
              />
            )}

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
                  <div className="flex h-7 w-7 items-center justify-center rounded-full bg-emerald-700 text-xs font-semibold text-white shadow">
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
                  : dayPlaces.activities.filter(
                      (a) => a.status === 'selected',
                    )
                return activities.map((activity, i) => (
                  <AdvancedMarker
                    key={`${day.id}-activity-${i}`}
                    position={{ lat: activity.lat, lng: activity.lng }}
                    title={activity.name}
                    data-testid="activity-marker"
                  >
                    <MarkerBadge
                      icon={CATEGORY_ICON[activity.category]}
                      selected={activity.status === 'selected'}
                    />
                  </AdvancedMarker>
                ))
              })}

            {tiers.showAllPlaces &&
              days.flatMap((day) => {
                const dayPlaces = places[day.id]
                if (!dayPlaces) return []
                return dayPlaces.restaurants.map((restaurant, i) => (
                  <AdvancedMarker
                    key={`${day.id}-restaurant-${i}`}
                    position={{ lat: restaurant.lat, lng: restaurant.lng }}
                    title={restaurant.name}
                    data-testid="restaurant-marker"
                  >
                    <MarkerBadge
                      icon={RESTAURANT_ICON}
                      selected={restaurant.status === 'selected'}
                    />
                  </AdvancedMarker>
                ))
              })}
          </GoogleMap>
        ) : (
          <p className="p-4 text-neutral-500">
            Set VITE_GOOGLE_MAPS_API_KEY to display the map.
          </p>
        )}
      </div>
    </div>
  )
}

export default OverviewMapScreen
