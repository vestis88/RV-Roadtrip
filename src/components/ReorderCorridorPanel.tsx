import { useState } from 'react'
import {
  previewReconcileCorridor,
  submitReconcileCorridor,
  type ReconcileCorridorPreview,
} from '../lib/reconcileCorridor'

interface ReorderCorridorPanelProps {
  tripId: string
  /** The trip's committed corridor stops, already sorted in their current
   * (day-index) order. */
  stops: { id: string; name: string }[]
  /** Locked stops with no linked day yet — a traveler-placed pin or a locked
   * rescan find, not yet reconciled into a real day (phase 4b). Offered as
   * "+ add" entries; including one generates its day via the detail phase
   * once confirmed. */
  addableStops: { id: string; name: string }[]
  /**
   * True while the plan is already being rewritten — including a submission
   * this client just made that the backend has not acknowledged yet. Same
   * prop, same reason, as AddRestDay/RequestChangesForDay/
   * OvernightCandidatesPicker.
   */
  planBusy: boolean
  /** Called once the planRequest write lands, so the busy state starts. */
  onSubmitted: () => void
  onClose: () => void
}

/**
 * "Lock in the new route" — reorder (phase 4a) plus add/remove (phase 4b).
 * No drag-and-drop — plain up/down buttons, same lesson HighlightsReviewPanel's
 * own re-ranking already learned (native drag-and-drop never worked reliably
 * on a touch device). Reviewed via a diff before anything writes: "Preview
 * changes" computes the reconciliation read-only, "Confirm" submits it
 * through the normal planRequests flow (same busy-guard as
 * replan/insertRestDay) and closes — the existing planMeta.status
 * "generating" banner covers the wait, same philosophy as AddRestDay.
 *
 * A stop removed here (left out of the order) has its day deleted outright;
 * an added stop (a locked pin/rescan-find with no linked day yet) gets a
 * brand new day generated. Either can change the trip's total day count, so
 * whenever the preview reports an `endDateChange`, this panel requires an
 * explicit tick before "Confirm" is enabled — an edit meant as "swap this
 * stop for that one" should never silently move the trip's return date.
 *
 * The doc comment above used to claim the existing "generating" banner
 * covered the wait. It does not cover the window this panel actually opens:
 * `loading` clears when the planRequest write resolves, the trip is still
 * 'ready' until generatePlan's trigger claims it a second or two later, and
 * "Edit route" on the map behind is immediately live again — so a second
 * reconciliation can be submitted against a route the first one is already
 * rewriting. That matters more here than anywhere else, because
 * reconcileCorridor recomputes every day's date from the stop order: run it
 * twice against overlapping state and days stretch rather than converge
 * (2026-08-13: a traveler trying to repair an already-corrupted trip through
 * this panel turned a one-night stop into four). Hence planBusy.
 */
export function ReorderCorridorPanel({
  tripId,
  stops,
  addableStops,
  planBusy,
  onSubmitted,
  onClose,
}: ReorderCorridorPanelProps) {
  const [order, setOrder] = useState<string[]>(stops.map((s) => s.id))
  const [step, setStep] = useState<'edit' | 'review'>('edit')
  const [preview, setPreview] = useState<ReconcileCorridorPreview | null>(null)
  const [acceptEndDateChange, setAcceptEndDateChange] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // The corridor is shared-trip data: another traveler adding, removing or
  // locking a stop while this panel is open would otherwise leave `order`
  // referencing stops that no longer exist (or missing new ones), and the
  // reconcile call would be computed from that stale list. Render-time
  // resync, the same pattern SettingsScreen/NotesScreen use — keyed on the
  // incoming stop ids, and only while still editing, so it can never
  // discard a reordering mid-review.
  const incomingIds = stops.map((s) => s.id).join('|')
  const [syncedIds, setSyncedIds] = useState(incomingIds)
  if (step === 'edit' && incomingIds !== syncedIds) {
    setSyncedIds(incomingIds)
    setOrder(stops.map((s) => s.id))
  }

  const nameById = new Map([...stops, ...addableStops].map((s) => [s.id, s.name]))
  const availableToAdd = addableStops.filter((s) => !order.includes(s.id))

  function move(index: number, delta: -1 | 1) {
    setOrder((prev) => {
      const next = [...prev]
      const target = index + delta
      if (target < 0 || target >= next.length) return prev
      ;[next[index], next[target]] = [next[target], next[index]]
      return next
    })
  }

  function remove(stopId: string) {
    setOrder((prev) => prev.filter((id) => id !== stopId))
  }

  function add(stopId: string) {
    setOrder((prev) => [...prev, stopId])
  }

  async function previewChanges() {
    setLoading(true)
    setError(null)
    try {
      const result = await previewReconcileCorridor(tripId, order)
      setPreview(result)
      setAcceptEndDateChange(false)
      setStep('review')
    } catch (err) {
      console.error('previewReconcileCorridor failed', err)
      setError('Could not preview this change — try again.')
    } finally {
      setLoading(false)
    }
  }

  async function confirm() {
    setLoading(true)
    setError(null)
    try {
      await submitReconcileCorridor(tripId, order, acceptEndDateChange)
      // Before the panel closes, so the busy banner is already up by the
      // time these controls disappear.
      onSubmitted()
      onClose()
    } catch (err) {
      console.error('submitReconcileCorridor failed', err)
      setError('Could not submit this change — try again.')
    } finally {
      setLoading(false)
    }
  }

  const hasAnyChange =
    !!preview &&
    (preview.changes.length > 0 ||
      preview.removedStopNames.length > 0 ||
      preview.addedDays.length > 0)
  const canConfirm =
    hasAnyChange && (!preview?.endDateChange || acceptEndDateChange)

  return (
    <div
      data-testid="reorder-corridor-panel"
      className="border-b border-neutral-200 bg-white p-4 dark:border-neutral-800 dark:bg-neutral-900"
    >
      {step === 'edit' && (
        <>
          <p className="mb-2 text-sm text-neutral-600 dark:text-neutral-300">
            Reorder, remove, or add stops, then preview the date/drive-leg
            changes before anything is applied.
          </p>
          <ol className="space-y-1.5">
            {order.map((stopId, index) => (
              <li
                key={stopId}
                data-testid={`reorder-stop-${stopId}`}
                className="flex items-center justify-between gap-2 rounded-lg border border-neutral-200 px-3 py-1.5 text-sm text-neutral-900 dark:border-neutral-700 dark:text-white"
              >
                <span>
                  {index + 1}. {nameById.get(stopId)}
                </span>
                <span className="flex gap-1">
                  <button
                    type="button"
                    data-testid={`reorder-stop-${stopId}-up`}
                    disabled={index === 0}
                    onClick={() => move(index, -1)}
                    className="btn btn-sm btn-secondary px-2 disabled:opacity-40"
                  >
                    ▲
                  </button>
                  <button
                    type="button"
                    data-testid={`reorder-stop-${stopId}-down`}
                    disabled={index === order.length - 1}
                    onClick={() => move(index, 1)}
                    className="btn btn-sm btn-secondary px-2 disabled:opacity-40"
                  >
                    ▼
                  </button>
                  <button
                    type="button"
                    data-testid={`reorder-stop-${stopId}-remove`}
                    disabled={order.length <= 1}
                    onClick={() => remove(stopId)}
                    className="btn btn-sm btn-secondary px-2 disabled:opacity-40"
                  >
                    ✕
                  </button>
                </span>
              </li>
            ))}
          </ol>

          {availableToAdd.length > 0 && (
            <div className="mt-3">
              <p className="mb-1 text-xs font-medium text-neutral-500 dark:text-neutral-400">
                Not yet in the route:
              </p>
              <ul className="space-y-1.5">
                {availableToAdd.map((stop) => (
                  <li
                    key={stop.id}
                    data-testid={`addable-stop-${stop.id}`}
                    className="flex items-center justify-between gap-2 rounded-lg border border-dashed border-neutral-300 px-3 py-1.5 text-sm text-neutral-900 dark:border-neutral-700 dark:text-white"
                  >
                    <span>{stop.name}</span>
                    <button
                      type="button"
                      data-testid={`addable-stop-${stop.id}-add`}
                      onClick={() => add(stop.id)}
                      className="btn btn-sm btn-secondary px-2"
                    >
                      + Add
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {error && (
            <p
              data-testid="reorder-preview-error"
              className="mt-2 text-sm text-red-600 dark:text-red-400"
            >
              {error}
            </p>
          )}
          <div className="mt-3 flex gap-2">
            <button
              type="button"
              data-testid="reorder-preview-button"
              disabled={loading}
              onClick={previewChanges}
              className="btn btn-sm btn-primary"
            >
              Preview changes
            </button>
            <button
              type="button"
              data-testid="reorder-cancel-button"
              onClick={onClose}
              className="btn btn-sm btn-secondary"
            >
              Cancel
            </button>
          </div>
        </>
      )}

      {step === 'review' && preview && (
        <>
          {hasAnyChange ? (
            <div className="space-y-2 text-sm text-neutral-900 dark:text-white">
              {preview.changes.length > 0 && (
                <ul data-testid="reorder-diff-list" className="space-y-1">
                  {preview.changes.map((change) => (
                    <li key={change.dayId} data-testid={`reorder-diff-${change.dayId}`}>
                      {change.overnightName}: {change.oldDate} → {change.newDate}
                    </li>
                  ))}
                </ul>
              )}
              {preview.removedStopNames.length > 0 && (
                <ul data-testid="reorder-removed-list" className="space-y-1">
                  {preview.removedStopNames.map((name) => (
                    <li key={name} data-testid={`reorder-removed-${name}`}>
                      Removed: {name}
                    </li>
                  ))}
                </ul>
              )}
              {preview.addedDays.length > 0 && (
                <ul data-testid="reorder-added-list" className="space-y-1">
                  {preview.addedDays.map((added) => (
                    <li key={added.overnightName} data-testid={`reorder-added-${added.overnightName}`}>
                      Added: {added.overnightName} — {added.date}
                    </li>
                  ))}
                </ul>
              )}
              {preview.endDateChange && (
                <label
                  data-testid="reorder-enddate-change"
                  className="flex items-start gap-2 rounded-lg border border-amber-300 bg-amber-50 p-2 text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-100"
                >
                  <input
                    type="checkbox"
                    data-testid="reorder-enddate-accept"
                    checked={acceptEndDateChange}
                    onChange={(event) => setAcceptEndDateChange(event.target.checked)}
                    className="mt-0.5"
                  />
                  <span>
                    This changes your trip's end date from{' '}
                    {preview.endDateChange.from} to {preview.endDateChange.to}. Tick
                    to accept.
                  </span>
                </label>
              )}
            </div>
          ) : (
            <p data-testid="reorder-no-changes" className="text-sm text-neutral-500 dark:text-neutral-400">
              No changes — this is already the current route.
            </p>
          )}
          {error && (
            <p className="mt-2 text-sm text-red-600 dark:text-red-400">{error}</p>
          )}
          <div className="mt-3 flex gap-2">
            {hasAnyChange && (
              <button
                type="button"
                data-testid="reorder-confirm-button"
                disabled={loading || planBusy || !canConfirm}
                onClick={confirm}
                className="btn btn-sm btn-primary disabled:opacity-40"
              >
                {planBusy ? 'Updating the plan…' : 'Confirm'}
              </button>
            )}
            <button
              type="button"
              data-testid="reorder-back-button"
              onClick={() => setStep('edit')}
              className="btn btn-sm btn-secondary"
            >
              Back
            </button>
          </div>
        </>
      )}
    </div>
  )
}
