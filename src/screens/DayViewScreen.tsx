import { useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import {
  AdvancedMarker,
  Map as GoogleMap,
  useMap,
} from '@vis.gl/react-google-maps'
import { useTripContext } from '../context/TripContext'
import { useTripDays } from '../hooks/useTripDays'
import { useDayDetail } from '../hooks/useDayDetail'
import { CardRow } from '../components/CardRow'
import { PlaceCard } from '../components/PlaceCard'
import { AddCustomStopForm } from '../components/AddCustomStopForm'
import { RequestChangesForDay } from '../components/RequestChangesForDay'
import { AddRestDay } from '../components/AddRestDay'
import { OvernightCandidatesPicker } from '../components/OvernightCandidatesPicker'
import { MarkerBadge } from '../components/MarkerBadge'
import { CATEGORY_ICON, OVERNIGHT_ICON, RESTAURANT_ICON } from '../lib/mapIcons'
import { markDone, markSelected, markSkipped } from '../lib/placeStatus'

interface SelectedPlace {
  id: string
  name: string
  lat: number
  lng: number
}

function MapPanner({ target }: { target: SelectedPlace | null }) {
  const map = useMap()
  useEffect(() => {
    if (map && target) map.panTo({ lat: target.lat, lng: target.lng })
  }, [map, target])
  return null
}

export function DayViewScreen() {
  const { tripId, trip } = useTripContext()
  const navigate = useNavigate()
  const { dayId } = useParams<{ dayId: string }>()
  const { days } = useTripDays(tripId)
  const { day, activities, restaurants, loading } = useDayDetail(tripId, dayId)
  const [selectedPlace, setSelectedPlace] = useState<SelectedPlace | null>(null)

  const dayIndex = days.findIndex((d) => d.id === dayId)
  const prevDayId = dayIndex > 0 ? days[dayIndex - 1].id : undefined
  const nextDayId =
    dayIndex >= 0 && dayIndex < days.length - 1
      ? days[dayIndex + 1].id
      : undefined

  function goToDay(id: string | undefined) {
    if (id) navigate(`/map/day/${id}`)
  }

  const apiKey = import.meta.env.VITE_GOOGLE_MAPS_API_KEY as string | undefined

  if (loading || !day || !dayId) {
    return (
      <p className="p-4 text-neutral-500 dark:text-neutral-400">Loading day…</p>
    )
  }

  const breakfast = restaurants.filter((r) => r.meal === 'breakfast')
  const lunch = restaurants.filter((r) => r.meal === 'lunch')
  const dinner = restaurants.filter((r) => r.meal === 'dinner')

  return (
    <div
      className="flex h-full w-full flex-col lg:flex-row"
      data-testid="day-view"
    >
      <div
        className="relative h-[45%] w-full shrink-0 lg:h-full lg:w-1/2"
        data-testid="day-map"
      >
        {apiKey ? (
          <GoogleMap
            defaultCenter={{ lat: day.overnight.lat, lng: day.overnight.lng }}
            defaultZoom={12}
            mapId="rv-day-view"
            gestureHandling="greedy"
          >
            <MapPanner target={selectedPlace} />

            <AdvancedMarker
              position={{ lat: day.overnight.lat, lng: day.overnight.lng }}
              title={day.overnight.name}
            >
              <MarkerBadge icon={OVERNIGHT_ICON} />
            </AdvancedMarker>

            {activities.map((activity, i) => {
              const placeId = `activity-card-${i}`
              return (
                <AdvancedMarker
                  key={`activity-${i}`}
                  position={{ lat: activity.lat, lng: activity.lng }}
                  title={activity.name}
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
            })}

            {restaurants.map((restaurant, i) => {
              const placeId = `${restaurant.meal}-card-${restaurants
                .filter((r) => r.meal === restaurant.meal)
                .indexOf(restaurant)}`
              return (
                <AdvancedMarker
                  key={`restaurant-${i}`}
                  position={{ lat: restaurant.lat, lng: restaurant.lng }}
                  title={restaurant.name}
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
            })}
          </GoogleMap>
        ) : (
          <div className="flex h-full w-full items-center justify-center bg-neutral-200 p-4 text-center text-neutral-500 dark:bg-neutral-800">
            Set VITE_GOOGLE_MAPS_API_KEY to display the map.
          </div>
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

      <div className="flex-1 overflow-y-auto bg-white text-left lg:w-1/2 dark:bg-neutral-900">
        <div className="flex items-center justify-between gap-2 px-4 pt-3 pb-2">
          <button
            type="button"
            data-testid="prev-day"
            disabled={!prevDayId}
            onClick={() => goToDay(prevDayId)}
            className="btn btn-sm btn-ghost"
          >
            ← Prev
          </button>
          <h2
            className="text-center text-base font-semibold tracking-tight text-neutral-900 dark:text-white"
            data-testid="day-view-date"
          >
            Day {day.index + 1} — {day.date}
          </h2>
          <button
            type="button"
            data-testid="next-day"
            disabled={!nextDayId}
            onClick={() => goToDay(nextDayId)}
            className="btn btn-sm btn-ghost"
          >
            Next →
          </button>
        </div>

        <p className="px-4 text-sm leading-relaxed text-neutral-600 dark:text-neutral-300">
          {day.summary}
        </p>

        {(day.highlightReason ?? day.extraTimeReason) && (
          <p
            className="mx-4 mt-2 rounded-lg bg-orange-50 px-3 py-2 text-sm text-orange-900 italic dark:bg-orange-950 dark:text-orange-200"
            data-testid="day-highlight-reason"
          >
            Why here: {day.highlightReason ?? day.extraTimeReason}
          </p>
        )}

        <RequestChangesForDay
          tripId={tripId}
          trip={trip}
          dayId={dayId}
          dayNumber={day.index + 1}
          allDayIds={days.map((d) => d.id)}
        />

        <AddRestDay
          tripId={tripId}
          dayId={dayId}
          overnightName={day.overnight.name}
        />

        <OvernightCandidatesPicker
          tripId={tripId}
          trip={trip}
          dayId={dayId}
          day={day}
          priorDayIds={days.filter((d) => d.index < day.index).map((d) => d.id)}
        />

        {day.type === 'rest' ? (
          <p
            className="mx-4 mt-4 rounded-xl bg-orange-50 p-3 font-medium text-orange-800 dark:bg-orange-950 dark:text-orange-200"
            data-testid="rest-day-banner"
          >
            No driving today 🎉
          </p>
        ) : (
          day.drive && (
            <div
              className="card mx-4 mt-4 p-3 text-sm"
              data-testid="drive-card"
            >
              <p className="font-semibold text-neutral-900 dark:text-white">
                {day.drive.fromName} → {day.drive.toName}
              </p>
              <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                <span className="chip chip-neutral">
                  {day.drive.distanceKm.toFixed(0)} km
                </span>
                <span className="chip chip-neutral">
                  {day.drive.durationMin.toFixed(0)} min
                </span>
                <span className="chip chip-neutral">{day.drive.slot}</span>
              </div>
            </div>
          )
        )}

        <AddCustomStopForm
          tripId={tripId}
          dayId={dayId}
          defaultLocation={{
            name: day.overnight.name,
            lat: day.overnight.lat,
            lng: day.overnight.lng,
          }}
        />

        <CardRow title="Activities" testId="activities-row">
          {activities.map((activity, i) => {
            const testId = `activity-card-${i}`
            return (
              <PlaceCard
                key={i}
                testId={testId}
                name={activity.name}
                category={activity.category}
                rating={activity.rating}
                ratingCount={activity.ratingCount}
                blurb={activity.blurb}
                photoUrl={activity.photoUrl}
                googleMapsUrl={activity.googleMapsUrl}
                status={activity.status}
                selected={selectedPlace?.id === testId}
                onTap={() =>
                  setSelectedPlace({
                    id: testId,
                    name: activity.name,
                    lat: activity.lat,
                    lng: activity.lng,
                  })
                }
                onMarkSelected={() =>
                  markSelected(tripId, dayId, 'activity', activity.id).catch(
                    console.error,
                  )
                }
                onMarkDone={(note) =>
                  markDone(
                    tripId,
                    dayId,
                    'activity',
                    activity.id,
                    day.date,
                    note,
                  ).catch(console.error)
                }
                onMarkSkipped={() =>
                  markSkipped(tripId, dayId, 'activity', activity.id).catch(
                    console.error,
                  )
                }
              />
            )
          })}
        </CardRow>

        <CardRow title="Breakfast" testId="breakfast-row">
          {breakfast.map((restaurant, i) => {
            const testId = `breakfast-card-${i}`
            return (
              <PlaceCard
                key={i}
                testId={testId}
                name={restaurant.name}
                rating={restaurant.rating}
                ratingCount={restaurant.ratingCount}
                blurb={restaurant.blurb}
                googleMapsUrl={restaurant.googleMapsUrl}
                photoUrl={restaurant.photoUrl}
                status={restaurant.status}
                selected={selectedPlace?.id === testId}
                onTap={() =>
                  setSelectedPlace({
                    id: testId,
                    name: restaurant.name,
                    lat: restaurant.lat,
                    lng: restaurant.lng,
                  })
                }
                onMarkSelected={() =>
                  markSelected(
                    tripId,
                    dayId,
                    'restaurant',
                    restaurant.id,
                  ).catch(console.error)
                }
                onMarkDone={(note) =>
                  markDone(
                    tripId,
                    dayId,
                    'restaurant',
                    restaurant.id,
                    day.date,
                    note,
                  ).catch(console.error)
                }
                onMarkSkipped={() =>
                  markSkipped(tripId, dayId, 'restaurant', restaurant.id).catch(
                    console.error,
                  )
                }
              />
            )
          })}
        </CardRow>

        <CardRow title="Lunch" testId="lunch-row">
          {lunch.map((restaurant, i) => {
            const testId = `lunch-card-${i}`
            return (
              <PlaceCard
                key={i}
                testId={testId}
                name={restaurant.name}
                rating={restaurant.rating}
                ratingCount={restaurant.ratingCount}
                blurb={restaurant.blurb}
                googleMapsUrl={restaurant.googleMapsUrl}
                photoUrl={restaurant.photoUrl}
                status={restaurant.status}
                selected={selectedPlace?.id === testId}
                onTap={() =>
                  setSelectedPlace({
                    id: testId,
                    name: restaurant.name,
                    lat: restaurant.lat,
                    lng: restaurant.lng,
                  })
                }
                onMarkSelected={() =>
                  markSelected(
                    tripId,
                    dayId,
                    'restaurant',
                    restaurant.id,
                  ).catch(console.error)
                }
                onMarkDone={(note) =>
                  markDone(
                    tripId,
                    dayId,
                    'restaurant',
                    restaurant.id,
                    day.date,
                    note,
                  ).catch(console.error)
                }
                onMarkSkipped={() =>
                  markSkipped(tripId, dayId, 'restaurant', restaurant.id).catch(
                    console.error,
                  )
                }
              />
            )
          })}
        </CardRow>

        <CardRow title="Dinner" testId="dinner-row">
          {dinner.map((restaurant, i) => {
            const testId = `dinner-card-${i}`
            return (
              <PlaceCard
                key={i}
                testId={testId}
                name={restaurant.name}
                rating={restaurant.rating}
                ratingCount={restaurant.ratingCount}
                blurb={restaurant.blurb}
                googleMapsUrl={restaurant.googleMapsUrl}
                photoUrl={restaurant.photoUrl}
                status={restaurant.status}
                selected={selectedPlace?.id === testId}
                onTap={() =>
                  setSelectedPlace({
                    id: testId,
                    name: restaurant.name,
                    lat: restaurant.lat,
                    lng: restaurant.lng,
                  })
                }
                onMarkSelected={() =>
                  markSelected(
                    tripId,
                    dayId,
                    'restaurant',
                    restaurant.id,
                  ).catch(console.error)
                }
                onMarkDone={(note) =>
                  markDone(
                    tripId,
                    dayId,
                    'restaurant',
                    restaurant.id,
                    day.date,
                    note,
                  ).catch(console.error)
                }
                onMarkSkipped={() =>
                  markSkipped(tripId, dayId, 'restaurant', restaurant.id).catch(
                    console.error,
                  )
                }
              />
            )
          })}
        </CardRow>
      </div>
    </div>
  )
}

export default DayViewScreen
