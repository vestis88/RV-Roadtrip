import { useState } from 'react'
import type { Trip } from '@rv/shared'
import { submitPlanChangeRequest } from '../lib/submitChangeRequest'

interface RequestChangesForDayProps {
  tripId: string
  trip: Trip
  dayId: string
  dayNumber: number
  allDayIds: string[]
}

/**
 * Day View's scoped variant of OverviewMapScreen's "Request changes": the
 * underlying replan already accepts lockedDayIds (days to leave untouched),
 * so "change just this day" is just "lock every day except this one" —
 * no new backend behavior, just a narrower default than the trip-wide form.
 */
export function RequestChangesForDay({
  tripId,
  trip,
  dayId,
  dayNumber,
  allDayIds,
}: RequestChangesForDayProps) {
  const [open, setOpen] = useState(false)
  const [changeText, setChangeText] = useState('')
  const [submitting, setSubmitting] = useState(false)

  async function submit() {
    setSubmitting(true)
    try {
      const lockedDayIds = allDayIds.filter((id) => id !== dayId)
      await submitPlanChangeRequest(tripId, trip, changeText, lockedDayIds)
      setChangeText('')
      setOpen(false)
    } catch (error) {
      console.error('Failed to submit per-day change request', error)
    } finally {
      setSubmitting(false)
    }
  }

  if (!open) {
    return (
      <div className="mx-4 mt-2">
        <button
          type="button"
          data-testid="request-changes-for-day-button"
          onClick={() => setOpen(true)}
          className="btn btn-sm btn-ghost -ml-3"
        >
          Request changes for this day
        </button>
      </div>
    )
  }

  return (
    <div
      data-testid="request-changes-for-day-form"
      className="card mx-4 mt-2 space-y-2 p-3"
    >
      <p className="text-sm text-neutral-500 dark:text-neutral-400">
        Change requested for Day {dayNumber} only — every other day stays as
        planned.
      </p>
      <textarea
        data-testid="change-request-text-for-day"
        className="field field-sm"
        placeholder="e.g. less driving today, add a beach stop"
        value={changeText}
        onChange={(event) => setChangeText(event.target.value)}
      />
      <div className="flex gap-2">
        <button
          type="button"
          data-testid="submit-change-request-for-day"
          disabled={submitting}
          onClick={submit}
          className="btn btn-sm btn-primary"
        >
          Submit
        </button>
        <button
          type="button"
          data-testid="cancel-change-request-for-day"
          onClick={() => setOpen(false)}
          className="btn btn-sm btn-secondary"
        >
          Cancel
        </button>
      </div>
    </div>
  )
}
