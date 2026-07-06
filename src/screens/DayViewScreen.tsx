import { useRef } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useTripContext } from '../context/TripContext'
import { useTripDays } from '../hooks/useTripDays'
import { useDayDetail } from '../hooks/useDayDetail'
import { CardRow } from '../components/CardRow'
import { PlaceCard } from '../components/PlaceCard'

const SWIPE_THRESHOLD_PX = 50

export function DayViewScreen() {
  const { tripId } = useTripContext()
  const navigate = useNavigate()
  const { dayId } = useParams<{ dayId: string }>()
  const { days } = useTripDays(tripId)
  const { day, activities, restaurants, loading } = useDayDetail(tripId, dayId)

  const touchStartX = useRef<number | null>(null)
  const dayIndex = days.findIndex((d) => d.id === dayId)
  const prevDayId = dayIndex > 0 ? days[dayIndex - 1].id : undefined
  const nextDayId =
    dayIndex >= 0 && dayIndex < days.length - 1
      ? days[dayIndex + 1].id
      : undefined

  function goToDay(id: string | undefined) {
    if (id) navigate(`/map/day/${id}`)
  }

  function onTouchStart(event: React.TouchEvent) {
    touchStartX.current = event.touches[0].clientX
  }

  function onTouchEnd(event: React.TouchEvent) {
    if (touchStartX.current == null) return
    const deltaX = event.changedTouches[0].clientX - touchStartX.current
    touchStartX.current = null
    if (Math.abs(deltaX) < SWIPE_THRESHOLD_PX) return
    goToDay(deltaX < 0 ? nextDayId : prevDayId)
  }

  if (loading || !day) {
    return (
      <p className="p-4 text-neutral-500 dark:text-neutral-400">
        Loading day…
      </p>
    )
  }

  const breakfast = restaurants.filter((r) => r.meal === 'breakfast')
  const lunch = restaurants.filter((r) => r.meal === 'lunch')
  const dinner = restaurants.filter((r) => r.meal === 'dinner')

  return (
    <div
      className="flex h-[calc(100svh-14rem)] w-full flex-col lg:flex-row"
      data-testid="day-view"
      onTouchStart={onTouchStart}
      onTouchEnd={onTouchEnd}
    >
      <div
        className="h-[45%] w-full shrink-0 bg-neutral-200 dark:bg-neutral-800 lg:h-full lg:w-1/2"
        data-testid="day-map"
      />

      <div className="flex-1 overflow-y-auto text-left lg:w-1/2">
        <div className="flex items-center justify-between p-4">
          <button
            type="button"
            data-testid="prev-day"
            disabled={!prevDayId}
            onClick={() => goToDay(prevDayId)}
            className="rounded px-3 py-1 text-sm underline disabled:opacity-30 disabled:no-underline"
          >
            ← Prev
          </button>
          <h2
            className="text-lg font-semibold text-neutral-900 dark:text-white"
            data-testid="day-view-date"
          >
            Day {day.index + 1} — {day.date}
          </h2>
          <button
            type="button"
            data-testid="next-day"
            disabled={!nextDayId}
            onClick={() => goToDay(nextDayId)}
            className="rounded px-3 py-1 text-sm underline disabled:opacity-30 disabled:no-underline"
          >
            Next →
          </button>
        </div>

        <p className="px-4 text-neutral-500 dark:text-neutral-400">
          {day.summary}
        </p>

        {day.type === 'rest' ? (
          <p
            className="mx-4 mt-4 rounded bg-emerald-50 p-3 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200"
            data-testid="rest-day-banner"
          >
            No driving today 🎉
          </p>
        ) : (
          day.drive && (
            <div
              className="mx-4 mt-4 rounded border border-neutral-200 p-3 text-sm dark:border-neutral-800"
              data-testid="drive-card"
            >
              <p className="font-medium text-neutral-900 dark:text-white">
                {day.drive.fromName} → {day.drive.toName}
              </p>
              <p className="text-neutral-600 dark:text-neutral-300">
                {day.drive.distanceKm.toFixed(0)}km,{' '}
                {day.drive.durationMin.toFixed(0)}min · {day.drive.slot}
              </p>
            </div>
          )
        )}

        <CardRow title="Activities" testId="activities-row">
          {activities.map((activity, i) => (
            <PlaceCard
              key={i}
              testId={`activity-card-${i}`}
              name={activity.name}
              category={activity.category}
              rating={activity.rating}
              ratingCount={activity.ratingCount}
              blurb={activity.blurb}
              photoUrl={activity.photoUrl}
            />
          ))}
        </CardRow>

        <CardRow title="Breakfast" testId="breakfast-row">
          {breakfast.map((restaurant, i) => (
            <PlaceCard
              key={i}
              testId={`breakfast-card-${i}`}
              name={restaurant.name}
              rating={restaurant.rating}
              ratingCount={restaurant.ratingCount}
              blurb={restaurant.blurb}
            />
          ))}
        </CardRow>

        <CardRow title="Lunch" testId="lunch-row">
          {lunch.map((restaurant, i) => (
            <PlaceCard
              key={i}
              testId={`lunch-card-${i}`}
              name={restaurant.name}
              rating={restaurant.rating}
              ratingCount={restaurant.ratingCount}
              blurb={restaurant.blurb}
            />
          ))}
        </CardRow>

        <CardRow title="Dinner" testId="dinner-row">
          {dinner.map((restaurant, i) => (
            <PlaceCard
              key={i}
              testId={`dinner-card-${i}`}
              name={restaurant.name}
              rating={restaurant.rating}
              ratingCount={restaurant.ratingCount}
              blurb={restaurant.blurb}
            />
          ))}
        </CardRow>
      </div>
    </div>
  )
}

export default DayViewScreen
