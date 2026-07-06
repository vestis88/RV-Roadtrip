import { Link, useParams } from 'react-router-dom'
import { useTripContext } from '../context/TripContext'
import { useTripDay } from '../hooks/useTripDay'

export function DayViewScreen() {
  const { tripId } = useTripContext()
  const { dayId } = useParams<{ dayId: string }>()
  const { day, loading } = useTripDay(tripId, dayId)

  return (
    <div className="mx-auto max-w-2xl p-4 text-left">
      <Link to="/map" className="text-sm underline">
        ← Back to map
      </Link>
      {loading || !day ? (
        <p className="mt-4 text-neutral-500 dark:text-neutral-400">
          Loading day…
        </p>
      ) : (
        <div className="mt-4" data-testid="day-view">
          <h2
            className="text-xl font-semibold text-neutral-900 dark:text-white"
            data-testid="day-view-date"
          >
            Day {day.index + 1} — {day.date}
          </h2>
          {day.type === 'rest' ? (
            <p className="mt-2 text-neutral-700 dark:text-neutral-300">
              No driving today 🎉
            </p>
          ) : (
            day.drive && (
              <p className="mt-2 text-neutral-700 dark:text-neutral-300">
                {day.drive.fromName} → {day.drive.toName} (
                {day.drive.distanceKm.toFixed(0)}km,{' '}
                {day.drive.durationMin.toFixed(0)}min)
              </p>
            )
          )}
          <p className="mt-2 text-neutral-500 dark:text-neutral-400">
            {day.summary}
          </p>
        </div>
      )}
    </div>
  )
}

export default DayViewScreen
