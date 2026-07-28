import { useState } from 'react'
import { submitInsertRestDay } from '../lib/addRestDay'

interface AddRestDayProps {
  tripId: string
  dayId: string
  overnightName: string
}

/**
 * "Postpone travelling by a day": inserts an extra rest day right after this
 * one. Confirmed inline rather than via window.confirm (same open/confirm/
 * cancel pattern as RequestChangesForDay and AddCustomStopForm) because the
 * effect reaches well past this screen — every later day moves.
 *
 * The request rides the normal planRequests flow, so the existing
 * planMeta.status === 'generating' busy state covers the wait; there's no
 * separate loading UI here beyond disabling the confirm button.
 */
export function AddRestDay({ tripId, dayId, overnightName }: AddRestDayProps) {
  const [open, setOpen] = useState(false)
  const [submitting, setSubmitting] = useState(false)

  async function confirm() {
    setSubmitting(true)
    try {
      await submitInsertRestDay(tripId, dayId)
      setOpen(false)
    } catch (error) {
      console.error('Failed to request an extra rest day', error)
    } finally {
      setSubmitting(false)
    }
  }

  if (!open) {
    return (
      <div className="mx-4 mt-2">
        <button
          type="button"
          data-testid="add-rest-day-button"
          onClick={() => setOpen(true)}
          className="btn btn-sm btn-ghost -ml-3"
        >
          Add a rest day here
        </button>
      </div>
    )
  }

  return (
    <div data-testid="add-rest-day-form" className="card mx-4 mt-2 space-y-2 p-3">
      <p className="text-sm text-neutral-500 dark:text-neutral-400">
        Add an extra day here? {overnightName} stays the plan for one more day,
        and every later day shifts back by one.
      </p>
      <div className="flex gap-2">
        <button
          type="button"
          data-testid="add-rest-day-confirm"
          disabled={submitting}
          onClick={confirm}
          className="btn btn-sm btn-primary"
        >
          Add rest day
        </button>
        <button
          type="button"
          data-testid="add-rest-day-cancel"
          onClick={() => setOpen(false)}
          className="btn btn-sm btn-secondary"
        >
          Cancel
        </button>
      </div>
    </div>
  )
}
