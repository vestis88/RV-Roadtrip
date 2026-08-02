import { useState } from 'react'
import type { LatLng } from '@rv/shared'
import { RESCAN_RADIUS_KM, rescanCorridorArea } from '../lib/rescanCorridorAction'
import { reverseGeocodeName } from '../lib/reverseGeocode'

interface RescanCorridorButtonProps {
  tripId: string
  center: LatLng
}

/**
 * "Rescan this area" (phase 3): searches near the map's current center and
 * writes any finds as new `proposed` corridorStops, which then render on the
 * map for the traveler to lock in or remove (see CorridorStopCard). No
 * result list here — the map itself is the result view, same philosophy as
 * everywhere else this corridor is edited directly on the map rather than in
 * a separate screen.
 */
export function RescanCorridorButton({ tripId, center }: RescanCorridorButtonProps) {
  const [loading, setLoading] = useState(false)
  const [status, setStatus] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function rescan() {
    setLoading(true)
    setError(null)
    setStatus(null)
    try {
      const centerName = await reverseGeocodeName(center)
      const result = await rescanCorridorArea(
        tripId,
        center,
        RESCAN_RADIUS_KM,
        undefined,
        undefined,
        centerName,
      )
      setStatus(
        result.stopsWritten > 0
          ? `Found ${result.stopsWritten} new stop${result.stopsWritten === 1 ? '' : 's'} nearby.`
          : 'Nothing new found nearby.',
      )
    } catch (err) {
      console.error('rescanCorridor failed', err)
      setError('Could not rescan this area right now.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <button
        type="button"
        data-testid="rescan-corridor-button"
        disabled={loading}
        onClick={rescan}
        className="btn btn-sm border border-dashed border-neutral-300 bg-white/95 text-neutral-600 shadow-md backdrop-blur-sm hover:bg-neutral-100 dark:border-neutral-700 dark:bg-neutral-900/95 dark:text-neutral-300 dark:hover:bg-neutral-800"
      >
        {loading ? 'Scanning…' : 'Rescan this area'}
      </button>
      {status && (
        <p
          data-testid="rescan-corridor-status"
          className="rounded bg-white/95 px-2 py-1 text-xs text-neutral-600 shadow-md backdrop-blur-sm dark:bg-neutral-900/95 dark:text-neutral-300"
        >
          {status}
        </p>
      )}
      {error && (
        <p
          data-testid="rescan-corridor-error"
          className="rounded bg-white/95 px-2 py-1 text-xs text-red-600 shadow-md backdrop-blur-sm dark:bg-neutral-900/95 dark:text-red-400"
        >
          {error}
        </p>
      )}
    </div>
  )
}
