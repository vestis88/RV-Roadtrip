import { useEffect, useRef, useState } from 'react'
import type { TripDay } from '@rv/shared'
import { dayDetailState, detailDaysFrom } from '../lib/dayDetailAction'

interface DayDetailGateProps {
  tripId: string
  dayId: string
  day: TripDay
}

/**
 * Asks for a day's detail the moment it is opened, and says what is
 * happening while it arrives.
 *
 * "Route eagerly, detail lazily": generation works out the route for the
 * whole trip and the activities/restaurants for only the first few days.
 * Opening a day past that window is what asks for it — this day and the two
 * after it, so paging forward through the trip stays ahead of the traveler
 * rather than pausing on every one.
 *
 * The request is fired once per day and the ANSWER is read back from the
 * day document, not from the promise. Same reasoning as the rescan button:
 * this component unmounts the moment the traveler navigates, and the server
 * carries on regardless — so the day's own detailStatus is the truth, and a
 * dropped connection is a fact about this phone rather than about the trip.
 */
export function DayDetailGate({ tripId, dayId, day }: DayDetailGateProps) {
  // A ref, not state: asking is a side effect with no bearing on what is
  // rendered, and setting state from inside the effect that reads it is both
  // a wasted render and the shape React lints against.
  const asked = useRef<string | null>(null)
  const [now, setNow] = useState(() => Date.now())
  const state = dayDetailState(day, now)

  useEffect(() => {
    if (state !== 'pending' && state !== 'stalled') return
    // Once per day per mount: `asked` is keyed on the day so paging forward
    // asks again for the next one, and a day already asked for does not get
    // a second paid call because a re-render happened.
    if (asked.current === dayId) return
    asked.current = dayId
    detailDaysFrom(tripId, dayId).catch((error: unknown) => {
      // Deliberately swallowed here — the cause is written onto the day by
      // the server and rendered below, which is the copy that survives this
      // component going away.
      console.error('detailDays failed', error)
    })
  }, [state, dayId, tripId])

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
      {state === 'working' || state === 'pending' ? (
        <p data-testid="day-detail-working">
          Working out what to do on this day…
        </p>
      ) : (
        <p data-testid="day-detail-stalled">
          That stopped partway through. Reopening this day will try again.
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
