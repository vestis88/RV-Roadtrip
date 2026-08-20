import { useState } from 'react'

import { describePlanDrift, type PlanDrift } from '../lib/planDrift'

interface ExecutionModePromptProps {
  /** Non-null only when the gap is worth interrupting for — see planDrift. */
  drift: PlanDrift | null
  permissionDenied: boolean
  onReplan: () => void
  onSnooze: () => void
  onManualPosition: (position: { lat: number; lng: number }) => void
}

export function ExecutionModePrompt({
  drift,
  permissionDenied,
  onReplan,
  onSnooze,
  onManualPosition,
}: ExecutionModePromptProps) {
  const [lat, setLat] = useState('')
  const [lng, setLng] = useState('')

  if (drift) {
    return (
      <div
        data-testid="replan-prompt"
        className="mx-4 mt-3 flex max-w-2xl flex-wrap items-center justify-between gap-3 rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 shadow-sm sm:mx-auto dark:border-amber-700 dark:bg-amber-950 dark:text-amber-100"
      >
        <span>
          {/* Days first, because that is the unit the decision is made in —
            * "180 km behind plan" is a number nobody paces a trip by. */}
          {describePlanDrift(drift)} Re-plan the rest of the trip?
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
        {/* Wrapped in real labels rather than relying on placeholders: a
            placeholder disappears the moment you start typing, leaving both
            boxes indistinguishable, and screen readers announced them as
            two unlabelled number inputs. */}
        <label className="flex items-center gap-1">
          <span className="text-xs text-neutral-500 dark:text-neutral-400">Lat</span>
          <input
            type="number"
            data-testid="manual-position-lat"
            placeholder="Latitude"
            value={lat}
            onChange={(event) => setLat(event.target.value)}
            className="field field-sm w-24"
          />
        </label>
        <label className="flex items-center gap-1">
          <span className="text-xs text-neutral-500 dark:text-neutral-400">Lng</span>
          <input
            type="number"
            data-testid="manual-position-lng"
            placeholder="Longitude"
            value={lng}
            onChange={(event) => setLng(event.target.value)}
            className="field field-sm w-24"
          />
        </label>
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
