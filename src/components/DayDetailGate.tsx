import { useEffect, useState } from 'react'
import type { TripDay } from '@rv/shared'
import { dayDetailState, detailDaysFrom } from '../lib/dayDetailAction'

interface DayDetailGateProps {
  tripId: string
  dayId: string
  day: TripDay
}

/**
 * Says what a day's detail is doing, and offers to fill the whole day in.
 *
 * IT NO LONGER ASKS ON ITS OWN, and that reversal is the point.
 *
 * It used to fire `detailDays` the moment a day was opened — this day and
 * the two after it. Reported 2026-08-25, after asking for a day list derived
 * from the locked stops and kept dynamic: "I want it more dynamic." The two
 * could not both be true. Generating detail sets `detailStatus: 'ready'`,
 * which is exactly the condition `planSkeleton` refuses to rebuild over — so
 * a traveler could rebuild a clean derived day list, OPEN one day to look at
 * it, and find the list frozen again. Detail was being bought by looking.
 *
 * Now it is bought by asking: each empty section offers to fill itself (see
 * DayViewScreen), and this offers the whole day at once for anyone who wants
 * all of it. Opening a day costs nothing, so the day list stays derived from
 * the stops for as long as nobody spends anything on it.
 *
 * The ANSWER is still read back from the day document rather than from the
 * promise — this component unmounts the moment the traveler navigates and
 * the server carries on regardless, so the day's own detailStatus is the
 * truth and a dropped connection is a fact about this phone.
 */
export function DayDetailGate({ tripId, dayId, day }: DayDetailGateProps) {
  const [asking, setAsking] = useState(false)
  const [askError, setAskError] = useState<string | null>(null)
  const [now, setNow] = useState(() => Date.now())
  const state = dayDetailState(day, now)

  async function fillWholeDay() {
    setAsking(true)
    setAskError(null)
    try {
      await detailDaysFrom(tripId, dayId)
    } catch (error) {
      // The cause is also written onto the day by the server, which is the
      // copy that survives this component going away — this one is for the
      // traveler still looking at it.
      console.error('detailDays failed', error)
      setAskError('Could not fill that in — please try again.')
    } finally {
      setAsking(false)
    }
  }

  // Only ticks while something is running, so a finished day is not
  // re-rendering once a second for a clock nobody is looking at.
  useEffect(() => {
    if (day.detailStatus !== 'generating') return
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [day.detailStatus])

  if (state === 'ready') return null

  return (
    <div
      data-testid="day-detail-gate"
      className="rounded-lg border border-dashed border-neutral-300 p-4 text-sm text-neutral-600 dark:border-neutral-700 dark:text-neutral-300"
    >
      {state === 'pending' ? (
        <div className="flex flex-wrap items-center gap-2">
          <p data-testid="day-detail-pending" className="flex-1">
            Nothing has been looked up for this day yet. Fill in a section
            below, or do the whole day at once.
          </p>
          <button
            type="button"
            data-testid="day-detail-fill-all"
            className="btn btn-sm btn-secondary disabled:opacity-40"
            disabled={asking}
            onClick={() => void fillWholeDay()}
          >
            {asking ? 'Working…' : 'Fill in this day'}
          </button>
        </div>
      ) : state === 'working' ? (
        <p data-testid="day-detail-working">
          Working out what to do on this day…
        </p>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <p data-testid="day-detail-stalled" className="flex-1">
            That stopped partway through.
          </p>
          <button
            type="button"
            data-testid="day-detail-fill-all"
            className="btn btn-sm btn-secondary disabled:opacity-40"
            disabled={asking}
            onClick={() => void fillWholeDay()}
          >
            {asking ? 'Working…' : 'Try again'}
          </button>
        </div>
      )}
      {askError && (
        <p
          data-testid="day-detail-ask-error"
          className="mt-2 text-xs text-red-600 dark:text-red-400"
        >
          {askError}
        </p>
      )}
      {day.detailError && (
        <p
          data-testid="day-detail-error"
          className="mt-2 text-xs text-red-600 dark:text-red-400"
        >
          Last attempt failed: {day.detailError}
        </p>
      )}
    </div>
  )
}
