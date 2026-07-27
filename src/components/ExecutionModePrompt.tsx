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
        className="mx-4 mt-3 flex max-w-2xl flex-wrap items-center justify-between gap-3 rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 shadow-sm sm:mx-auto dark:border-amber-700 dark:bg-amber-950 dark:text-amber-100"
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
            className="btn btn-sm btn-primary"
          >
            Re-plan
          </button>
          <button
            type="button"
            data-testid="replan-prompt-snooze"
            onClick={onSnooze}
            className="btn btn-sm border border-amber-400 text-amber-900 hover:bg-amber-100 dark:text-amber-100 dark:hover:bg-amber-900"
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
        className="card mx-4 mt-3 flex max-w-2xl flex-wrap items-center gap-2 p-3 text-sm text-neutral-900 sm:mx-auto dark:text-white"
      >
        <span>Location access is off — enter where you are:</span>
        <input
          type="number"
          data-testid="manual-position-lat"
          placeholder="Latitude"
          value={lat}
          onChange={(event) => setLat(event.target.value)}
          className="field field-sm w-24"
        />
        <input
          type="number"
          data-testid="manual-position-lng"
          placeholder="Longitude"
          value={lng}
          onChange={(event) => setLng(event.target.value)}
          className="field field-sm w-24"
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
          className="btn btn-sm btn-primary"
        >
          I'm here
        </button>
      </div>
    )
  }

  return null
}
