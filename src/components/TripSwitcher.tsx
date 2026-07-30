import type { TripSummary } from '../hooks/useMyTrips'

interface TripSwitcherProps {
  trips: TripSummary[]
  currentTripId: string
  onSwitch: (tripId: string) => void
  onCreate: () => void
  creating: boolean
}

/** Same lightweight non-modal `<details>` toggle pattern as ShareTripMenu,
 * placed right next to it on Trip setup. */
export function TripSwitcher({
  trips,
  currentTripId,
  onSwitch,
  onCreate,
  creating,
}: TripSwitcherProps) {
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
              return (
                <li key={trip.id}>
                  <button
                    type="button"
                    data-testid={`trip-switcher-item-${trip.id}`}
                    disabled={active}
                    onClick={() => onSwitch(trip.id)}
                    className={`w-full rounded-lg border px-3 py-1.5 text-left text-sm ${
                      active
                        ? 'border-orange-600 bg-orange-50 font-medium text-orange-900 dark:bg-orange-950 dark:text-orange-100'
                        : 'border-neutral-200 text-neutral-900 hover:bg-neutral-50 dark:border-neutral-700 dark:text-white dark:hover:bg-neutral-800'
                    }`}
                  >
                    {trip.name || 'Untitled trip'}
                    <span className="ml-1.5 text-xs text-neutral-500 dark:text-neutral-400">
                      {trip.startDate} – {trip.endDate}
                    </span>
                  </button>
                </li>
              )
            })}
          </ul>
        )}
      </div>
    </details>
  )
}
