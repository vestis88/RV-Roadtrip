import { useState } from 'react'
import type { ReconcileDayChange } from '@rv/shared'
import {
  previewReconcileCorridor,
  submitReconcileCorridor,
} from '../lib/reconcileCorridor'

interface ReorderCorridorPanelProps {
  tripId: string
  /** The trip's committed corridor stops, already sorted in their current
   * (day-index) order. */
  stops: { id: string; name: string }[]
  onClose: () => void
}

/**
 * "Lock in the new route", phase 4a. No drag-and-drop — plain up/down
 * buttons, same lesson HighlightsReviewPanel's own re-ranking already
 * learned (native drag-and-drop never worked reliably on a touch device).
 * Reviewed via a diff before anything writes: "Preview changes" computes the
 * reconciliation read-only, "Confirm" submits it through the normal
 * planRequests flow (same busy-guard as replan/insertRestDay) and closes —
 * the existing planMeta.status "generating" banner covers the wait, same
 * philosophy as AddRestDay.
 */
export function ReorderCorridorPanel({
  tripId,
  stops,
  onClose,
}: ReorderCorridorPanelProps) {
  const [order, setOrder] = useState<string[]>(stops.map((s) => s.id))
  const [step, setStep] = useState<'edit' | 'review'>('edit')
  const [changes, setChanges] = useState<ReconcileDayChange[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const nameById = new Map(stops.map((s) => [s.id, s.name]))

  function move(index: number, delta: -1 | 1) {
    setOrder((prev) => {
      const next = [...prev]
      const target = index + delta
      if (target < 0 || target >= next.length) return prev
      ;[next[index], next[target]] = [next[target], next[index]]
      return next
    })
  }

  async function previewChanges() {
    setLoading(true)
    setError(null)
    try {
      const result = await previewReconcileCorridor(tripId, order)
      setChanges(result)
      setStep('review')
    } catch (err) {
      console.error('previewReconcileCorridor failed', err)
      setError('Could not preview this reorder — try again.')
    } finally {
      setLoading(false)
    }
  }

  async function confirm() {
    setLoading(true)
    setError(null)
    try {
      await submitReconcileCorridor(tripId, order)
      onClose()
    } catch (err) {
      console.error('submitReconcileCorridor failed', err)
      setError('Could not submit this reorder — try again.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div
      data-testid="reorder-corridor-panel"
      className="border-b border-neutral-200 bg-white p-4 dark:border-neutral-800 dark:bg-neutral-900"
    >
      {step === 'edit' && (
        <>
          <p className="mb-2 text-sm text-neutral-600 dark:text-neutral-300">
            Reorder your stops, then preview the date/drive-leg changes before
            anything is applied.
          </p>
          <ol className="space-y-1.5">
            {order.map((stopId, index) => (
              <li
                key={stopId}
                data-testid={`reorder-stop-${stopId}`}
                className="flex items-center justify-between gap-2 rounded-lg border border-neutral-200 px-3 py-1.5 text-sm dark:border-neutral-700"
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
                </span>
              </li>
            ))}
          </ol>
          {error && (
            <p className="mt-2 text-sm text-red-600 dark:text-red-400">{error}</p>
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

      {step === 'review' && (
        <>
          {changes && changes.length > 0 ? (
            <ul data-testid="reorder-diff-list" className="space-y-1 text-sm">
              {changes.map((change) => (
                <li key={change.dayId} data-testid={`reorder-diff-${change.dayId}`}>
                  {change.overnightName}: {change.oldDate} → {change.newDate}
                </li>
              ))}
            </ul>
          ) : (
            <p data-testid="reorder-no-changes" className="text-sm text-neutral-500 dark:text-neutral-400">
              No changes — this is already the current order.
            </p>
          )}
          {error && (
            <p className="mt-2 text-sm text-red-600 dark:text-red-400">{error}</p>
          )}
          <div className="mt-3 flex gap-2">
            {changes && changes.length > 0 && (
              <button
                type="button"
                data-testid="reorder-confirm-button"
                disabled={loading}
                onClick={confirm}
                className="btn btn-sm btn-primary"
              >
                Confirm
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
