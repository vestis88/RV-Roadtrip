import { useState } from 'react'
import type { TripSummary } from '../hooks/useMyTrips'

interface TripSwitcherProps {
  trips: TripSummary[]
  currentTripId: string
  onSwitch: (tripId: string) => void
  onCreate: () => void
  onDelete: (tripId: string) => Promise<void>
  creating: boolean
}

/** Same lightweight non-modal `<details>` toggle pattern as ShareTripMenu,
 * placed right next to it on Trip setup. */
export function TripSwitcher({
  trips,
  currentTripId,
  onSwitch,
  onCreate,
  onDelete,
  creating,
}: TripSwitcherProps) {
  const [confirmingId, setConfirmingId] = useState<string | null>(null)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [deleteError, setDeleteError] = useState<string | null>(null)

  async function confirmDelete(tripId: string) {
    setDeletingId(tripId)
    setDeleteError(null)
    try {
      await onDelete(tripId)
    } catch (error) {
      // Without this the rejection was unhandled and the row just returned
      // to normal — indistinguishable from a trip that really was deleted.
      console.error('Failed to delete trip', error)
      setDeleteError('Could not delete that trip — please try again.')
    } finally {
      setDeletingId(null)
      setConfirmingId(null)
    }
  }

  return (
    <details className="mx-auto max-w-xs text-center" data-testid="trip-switcher">
      <summary
        data-testid="trip-switcher-toggle"
        className="link inline-block cursor-pointer py-2 text-sm"
      >
        My trips ({trips.length})
      </summary>
      <div className="mt-2 space-y-2">
        <button
          type="button"
          data-testid="new-trip-button"
          disabled={creating}
          onClick={onCreate}
          className="btn btn-sm btn-primary w-full"
        >
          {creating ? 'Creating…' : '+ New trip'}
        </button>
        {trips.length > 0 && (
          <ul className="space-y-1.5 text-left">
            {trips.map((trip) => {
              const active = trip.id === currentTripId
              const confirming = confirmingId === trip.id
              return (
                <li
                  key={trip.id}
                  className={`flex items-center gap-1.5 rounded-lg border px-1.5 py-1 ${
                    active
                      ? 'border-orange-600 bg-orange-50 dark:bg-orange-950'
                      : 'border-neutral-200 dark:border-neutral-700'
                  }`}
                >
                  <button
                    type="button"
                    data-testid={`trip-switcher-item-${trip.id}`}
                    disabled={active}
                    onClick={() => onSwitch(trip.id)}
                    className={`min-w-0 flex-1 truncate rounded px-1.5 py-0.5 text-left text-sm ${
                      active
                        ? 'font-medium text-orange-900 dark:text-orange-100'
                        : 'text-neutral-900 hover:bg-neutral-50 dark:text-white dark:hover:bg-neutral-800'
                    }`}
                  >
                    {trip.name || 'Untitled trip'}
                    <span className="ml-1.5 text-xs text-neutral-500 dark:text-neutral-400">
                      {trip.startDate} – {trip.endDate}
                    </span>
                  </button>
                  {confirming ? (
                    <>
                      <button
                        type="button"
                        data-testid={`trip-delete-confirm-${trip.id}`}
                        disabled={deletingId === trip.id}
                        onClick={() => void confirmDelete(trip.id)}
                        className="btn btn-sm btn-secondary shrink-0 text-red-600 dark:text-red-400"
                      >
                        {deletingId === trip.id ? '…' : 'Confirm'}
                      </button>
                      <button
                        type="button"
                        data-testid={`trip-delete-cancel-${trip.id}`}
                        disabled={deletingId === trip.id}
                        onClick={() => setConfirmingId(null)}
                        className="btn btn-sm btn-secondary shrink-0"
                      >
                        Cancel
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      data-testid={`trip-delete-${trip.id}`}
                      onClick={() => setConfirmingId(trip.id)}
                      className="shrink-0 rounded px-1.5 py-1 text-neutral-400 hover:text-red-600 dark:text-neutral-500 dark:hover:text-red-400"
                      aria-label={`Delete ${trip.name || 'Untitled trip'}`}
                    >
                      ✕
                    </button>
                  )}
                </li>
              )
            })}
          </ul>
        )}
        {deleteError && (
          <p data-testid="trip-delete-error" className="px-2 py-1 text-sm text-red-600">
            {deleteError}
          </p>
        )}
      </div>
    </details>
  )
}
