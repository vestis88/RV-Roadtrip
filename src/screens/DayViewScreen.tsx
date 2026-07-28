import { useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import {
  AdvancedMarker,
  Map as GoogleMap,
  useMap,
} from '@vis.gl/react-google-maps'
import { useTripContext } from '../context/TripContext'
import { useTripDays } from '../hooks/useTripDays'
import { useDayDetail, type ActivityWithId, type RestaurantWithId } from '../hooks/useDayDetail'
import { CardRow } from '../components/CardRow'
import { PlaceCard } from '../components/PlaceCard'
import { AddCustomStopForm } from '../components/AddCustomStopForm'
import { RequestChangesForDay } from '../components/RequestChangesForDay'
import { AddRestDay } from '../components/AddRestDay'
import { OvernightCandidatesPicker } from '../components/OvernightCandidatesPicker'
import { MarkerBadge } from '../components/MarkerBadge'
import { CATEGORY_ICON, OVERNIGHT_ICON, RESTAURANT_ICON } from '../lib/mapIcons'
import {
  markDone,
  markSelected,
  markSkipped,
  type PlaceKind,
} from '../lib/placeStatus'

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

interface IndexedPlace {
  index: number
  place: ActivityWithId | RestaurantWithId
}

/**
 * One CardRow's worth of activity/restaurant options. A skipped item used to
 * just sit in place with a dimmer label — reported as "skipping does not
 * remove the card and reveal a new one" — so it's tucked behind a "Show
 * skipped" toggle instead: gone from the main scroller by default (clearing
 * room for whatever else was generated for this slot), reversible by
 * expanding the toggle and tapping Select again rather than lost outright.
 */
function PlaceCardSection({
  title,
  rowTestId,
  cardIdPrefix,
  kind,
  entries,
  tripId,
  dayId,
  date,
  selectedPlaceId,
  onSelect,
}: {
  title: string
  rowTestId: string
  cardIdPrefix: string
  kind: PlaceKind
  entries: IndexedPlace[]
  tripId: string
  dayId: string
  date: string
  selectedPlaceId: string | undefined
  onSelect: (cardId: string, place: { name: string; lat: number; lng: number }) => void
}) {
  const [showSkipped, setShowSkipped] = useState(false)
  const active = entries.filter(({ place }) => place.status !== 'skipped')
  const skipped = entries.filter(({ place }) => place.status === 'skipped')
  const visible = showSkipped ? [...active, ...skipped] : active

  return (
    <CardRow
      title={title}
      testId={rowTestId}
      footer={
        skipped.length > 0 ? (
          <button
            type="button"
            data-testid={`${rowTestId}-show-skipped`}
            onClick={() => setShowSkipped((v) => !v)}
            className="text-xs text-neutral-500 underline underline-offset-2 dark:text-neutral-400"
          >
            {showSkipped ? 'Hide' : 'Show'} {skipped.length} skipped
          </button>
        ) : undefined
      }
    >
      {visible.map(({ index, place }) => {
        const cardId = `${cardIdPrefix}-card-${index}`
        return (
          <div
            key={index}
            className={place.status === 'skipped' ? 'opacity-60' : undefined}
          >
            <PlaceCard
              testId={cardId}
              name={place.name}
              category={'category' in place ? place.category : undefined}
              rating={place.rating}
              ratingCount={place.ratingCount}
              blurb={place.blurb}
              photoUrl={place.photoUrl}
              googleMapsUrl={place.googleMapsUrl}
              status={place.status}
              selected={selectedPlaceId === cardId}
              onTap={() =>
                onSelect(cardId, {
                  name: place.name,
                  lat: place.lat,
                  lng: place.lng,
                })
              }
              onMarkSelected={() =>
                markSelected(tripId, dayId, kind, place.id).catch(console.error)
              }
              onMarkDone={(note) =>
                markDone(tripId, dayId, kind, place.id, date, note).catch(
                  console.error,
                )
              }
              onMarkSkipped={() =>
                markSkipped(tripId, dayId, kind, place.id).catch(console.error)
              }
            />
          </div>
        )
      })}
    </CardRow>
  )
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

        <PlaceCardSection
          title="Activities"
          rowTestId="activities-row"
          cardIdPrefix="activity"
          kind="activity"
          entries={activities.map((place, index) => ({ index, place }))}
          tripId={tripId}
          dayId={dayId}
          date={day.date}
          selectedPlaceId={selectedPlace?.id}
          onSelect={(cardId, place) => setSelectedPlace({ id: cardId, ...place })}
        />

        <PlaceCardSection
          title="Breakfast"
          rowTestId="breakfast-row"
          cardIdPrefix="breakfast"
          kind="restaurant"
          entries={breakfast.map((place, index) => ({ index, place }))}
          tripId={tripId}
          dayId={dayId}
          date={day.date}
          selectedPlaceId={selectedPlace?.id}
          onSelect={(cardId, place) => setSelectedPlace({ id: cardId, ...place })}
        />

        <PlaceCardSection
          title="Lunch"
          rowTestId="lunch-row"
          cardIdPrefix="lunch"
          kind="restaurant"
          entries={lunch.map((place, index) => ({ index, place }))}
          tripId={tripId}
          dayId={dayId}
          date={day.date}
          selectedPlaceId={selectedPlace?.id}
          onSelect={(cardId, place) => setSelectedPlace({ id: cardId, ...place })}
        />

        <PlaceCardSection
          title="Dinner"
          rowTestId="dinner-row"
          cardIdPrefix="dinner"
          kind="restaurant"
          entries={dinner.map((place, index) => ({ index, place }))}
          tripId={tripId}
          dayId={dayId}
          date={day.date}
          selectedPlaceId={selectedPlace?.id}
          onSelect={(cardId, place) => setSelectedPlace({ id: cardId, ...place })}
        />
      </div>
    </div>
  )
}

export default DayViewScreen
