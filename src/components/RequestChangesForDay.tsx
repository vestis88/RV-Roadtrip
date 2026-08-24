import { useState } from 'react'
import type { Trip } from '@rv/shared'
import { submitPlanChangeRequest } from '../lib/submitChangeRequest'

interface RequestChangesForDayProps {
  tripId: string
  trip: Trip
  dayId: string
  dayNumber: number
  allDayIds: string[]
  /** See AddRestDay — same busy state, same reason. */
  planBusy: boolean
  onSubmitted: () => void
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
  planBusy,
  onSubmitted,
}: RequestChangesForDayProps) {
  const [open, setOpen] = useState(false)
  const [changeText, setChangeText] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit() {
    setError(null)
    // Submitting blank fired a real replan with no instructions at all —
    // the same expensive regeneration ConfirmGenerateDialog exists to gate,
    // triggered by an empty textarea.
    if (!changeText.trim()) {
      setError('Describe what you would like changed first.')
      return
    }
    setSubmitting(true)
    try {
      const lockedDayIds = allDayIds.filter((id) => id !== dayId)
      await submitPlanChangeRequest(tripId, trip, changeText, lockedDayIds)
      // Raise the busy banner before the form closes — a form that vanishes
      // into an unchanged screen is exactly what "nothing happens" looked
      // like, and a replan is far slower than a rest-day insert.
      onSubmitted()
      setChangeText('')
      setOpen(false)
    } catch (err) {
      console.error('Failed to submit per-day change request', err)
      setError('Could not send that request — please try again.')
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
          disabled={planBusy}
          onClick={() => setOpen(true)}
          className="btn btn-sm btn-ghost -ml-3 disabled:opacity-40"
        >
          {planBusy ? 'Updating the plan…' : 'Request changes for this day'}
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
          disabled={submitting || planBusy}
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
      {error && (
        <p
          data-testid="request-changes-for-day-error"
          className="text-sm text-red-600 dark:text-red-400"
        >
          {error}
        </p>
      )}
    </div>
  )
}
