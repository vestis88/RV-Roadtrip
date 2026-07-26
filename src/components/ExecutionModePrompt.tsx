import { useState } from 'react'

interface ExecutionModePromptProps {
  behindKm: number | null
  permissionDenied: boolean
  onReplan: () => void
  onSnooze: () => void
  onManualPosition: (position: { lat: number; lng: number }) => void
}

export function ExecutionModePrompt({
  behindKm,
  permissionDenied,
  onReplan,
  onSnooze,
  onManualPosition,
}: ExecutionModePromptProps) {
  const [lat, setLat] = useState('')
  const [lng, setLng] = useState('')

  if (behindKm != null) {
    return (
      <div
        data-testid="replan-prompt"
        className="mx-auto mt-2 flex max-w-2xl items-center justify-between gap-3 rounded border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-100"
      >
        <span>
          You're {behindKm.toFixed(0)} km behind plan. Re-plan the rest of the
          trip?
        </span>
        <div className="flex shrink-0 gap-2">
          <button
            type="button"
            data-testid="replan-prompt-replan"
            onClick={onReplan}
            className="rounded bg-orange-600 px-3 py-1 text-white"
          >
            Re-plan
          </button>
          <button
            type="button"
            data-testid="replan-prompt-snooze"
            onClick={onSnooze}
            className="rounded border border-amber-400 px-3 py-1"
          >
            Snooze today
          </button>
        </div>
      </div>
    )
  }

  if (permissionDenied) {
    return (
      <div
        data-testid="manual-position-prompt"
        className="mx-auto mt-2 flex max-w-2xl flex-wrap items-center gap-2 rounded border border-neutral-300 bg-neutral-50 p-3 text-sm text-neutral-900 dark:border-neutral-700 dark:bg-neutral-900 dark:text-white"
      >
        <span>Location access is off — enter where you are:</span>
        <input
          type="number"
          data-testid="manual-position-lat"
          placeholder="Latitude"
          value={lat}
          onChange={(event) => setLat(event.target.value)}
          className="w-24 rounded border border-neutral-300 px-2 py-1 dark:border-neutral-700 dark:bg-neutral-800 dark:text-white"
        />
        <input
          type="number"
          data-testid="manual-position-lng"
          placeholder="Longitude"
          value={lng}
          onChange={(event) => setLng(event.target.value)}
          className="w-24 rounded border border-neutral-300 px-2 py-1 dark:border-neutral-700 dark:bg-neutral-800 dark:text-white"
        />
        <button
          type="button"
          data-testid="manual-position-submit"
          onClick={() => {
            const parsedLat = Number(lat)
            const parsedLng = Number(lng)
            if (Number.isNaN(parsedLat) || Number.isNaN(parsedLng)) return
            onManualPosition({ lat: parsedLat, lng: parsedLng })
          }}
          className="rounded bg-orange-600 px-3 py-1 text-white"
        >
          I'm here
        </button>
      </div>
    )
  }

  return null
}
