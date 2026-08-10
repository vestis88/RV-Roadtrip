import { useState } from 'react'
import { submitInsertRestDay } from '../lib/addRestDay'

interface AddRestDayProps {
  tripId: string
  dayId: string
  overnightName: string
  /**
   * True while the plan is already being rewritten — including a submission
   * this client just made that the backend has not acknowledged yet.
   */
  planBusy: boolean
  /** Called once the planRequest write lands, so the busy state starts. */
  onSubmitted: () => void
}

/**
 * "Postpone travelling by a day": inserts an extra rest day right after this
 * one. Confirmed inline rather than via window.confirm (same open/confirm/
 * cancel pattern as RequestChangesForDay and AddCustomStopForm) because the
 * effect reaches well past this screen — every later day moves.
 *
 * This used to assume "the existing planMeta.status === 'generating' busy
 * state covers the wait" and render no loading UI of its own. That was true
 * of Overview and Settings and false of Day View, which is the only screen
 * this component appears on — so a confirmed rest day produced no visible
 * change whatsoever. Since runInsertRestDay is mechanical and sub-second,
 * the button was live again immediately, and repeated taps each inserted
 * another day: a three-day trip became eleven. The busy state is now passed
 * in explicitly rather than assumed to exist somewhere up the tree.
 */
export function AddRestDay({
  tripId,
  dayId,
  overnightName,
  planBusy,
  onSubmitted,
}: AddRestDayProps) {
  const [open, setOpen] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function confirm() {
    setSubmitting(true)
    setError(null)
    try {
      await submitInsertRestDay(tripId, dayId)
      // Before closing the form, so the busy banner is already up by the time
      // the controls disappear — closing into an unchanged screen is what
      // made this look like nothing had happened.
      onSubmitted()
      setOpen(false)
    } catch (err) {
      // Previously console-only: the button simply returned to normal and
      // the traveler had no way to tell the request had failed.
      console.error('Failed to request an extra rest day', err)
      setError('Could not add a rest day — please try again.')
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
          // Structural changes stack: each one shifts every later day, and
          // they are not idempotent. While one is in flight there is nothing
          // sensible a second can mean.
          disabled={planBusy}
          onClick={() => setOpen(true)}
          className="btn btn-sm btn-ghost -ml-3 disabled:opacity-40"
        >
          {planBusy ? 'Updating the plan…' : 'Add a rest day here'}
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
          disabled={submitting || planBusy}
          onClick={confirm}
          className="btn btn-sm btn-primary disabled:opacity-40"
        >
          {submitting ? 'Adding…' : 'Add rest day'}
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
      {error && (
        <p data-testid="add-rest-day-error" className="text-sm text-red-600">
          {error}
        </p>
      )}
    </div>
  )
}
