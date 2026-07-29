import type { CorridorStopWithId } from '../hooks/useCorridorStops'
import { isoCountryFlag } from '../lib/countryFlag'

interface CorridorStopCardProps {
  stop: CorridorStopWithId
  onLock: () => void
  onUnlock: () => void
  onRemove: () => void
  onClose: () => void
}

/**
 * The lightweight, non-modal tap-to-reveal surface a corridor-stop marker
 * opens — anchored off the tapped marker, not a separate list screen (see
 * master_plan.md's correction against reusing HighlightsReviewPanel's list
 * chrome). Only ever shown for `proposed`/`locked` stops (see
 * OverviewMapScreen.tsx) — `committed` stops are already represented by
 * their day badge, and locking/removing one is a phase-4 reconciliation
 * concern, not this card's.
 */
export function CorridorStopCard({
  stop,
  onLock,
  onUnlock,
  onRemove,
  onClose,
}: CorridorStopCardProps) {
  return (
    <div
      data-testid="corridor-stop-card"
      className="card absolute top-3 right-3 max-w-xs space-y-2 p-3 text-sm shadow-lg"
    >
      <div className="flex items-start justify-between gap-2">
        <p className="font-semibold text-neutral-900 dark:text-white">
          {stop.name} {stop.country && isoCountryFlag(stop.country)}
        </p>
        <button
          type="button"
          data-testid="corridor-stop-close"
          onClick={onClose}
          className="text-neutral-400 hover:text-neutral-600 dark:hover:text-neutral-200"
          aria-label="Close"
        >
          ✕
        </button>
      </div>
      {stop.why && (
        <p className="text-xs leading-relaxed text-neutral-600 dark:text-neutral-300">
          {stop.why}
        </p>
      )}
      <p
        data-testid="corridor-stop-status"
        className="text-xs text-neutral-500 dark:text-neutral-400"
      >
        Status: {stop.status}
      </p>
      <div className="flex flex-wrap gap-1.5">
        {stop.status === 'proposed' && (
          <button
            type="button"
            data-testid="corridor-stop-lock"
            onClick={onLock}
            className="btn btn-sm btn-primary"
          >
            Lock in
          </button>
        )}
        {stop.status === 'locked' && (
          <button
            type="button"
            data-testid="corridor-stop-unlock"
            onClick={onUnlock}
            className="btn btn-sm btn-secondary"
          >
            Unlock
          </button>
        )}
        <button
          type="button"
          data-testid="corridor-stop-remove"
          onClick={onRemove}
          className="btn btn-sm btn-secondary text-neutral-500 dark:text-neutral-400"
        >
          Remove
        </button>
      </div>
    </div>
  )
}
