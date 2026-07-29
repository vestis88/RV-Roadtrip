import { useState } from 'react'
import type { ItemStatus } from '@rv/shared'

interface PlaceCardProps {
  testId: string
  name: string
  category?: string
  rating?: number
  ratingCount?: number
  blurb: string
  photoUrl?: string
  googleMapsUrl?: string
  selected?: boolean
  onTap?: () => void
  status?: ItemStatus
  /** Toggles between 'selected' and 'suggested' — the caller decides which
   * way based on the current `status`, this button just always shows the
   * opposite of whatever's current ("Select" / "Unselect"). */
  onToggleSelected?: () => void
  onMarkDone?: (note: string) => void
  onMarkSkipped?: () => void
}

export function PlaceCard({
  testId,
  name,
  category,
  rating,
  ratingCount,
  blurb,
  photoUrl,
  googleMapsUrl,
  selected,
  onTap,
  status,
  onToggleSelected,
  onMarkDone,
  onMarkSkipped,
}: PlaceCardProps) {
  const [noteDraft, setNoteDraft] = useState('')
  const [addingNote, setAddingNote] = useState(false)

  function stop(event: { stopPropagation: () => void }) {
    event.stopPropagation()
  }

  return (
    <div
      role={onTap ? 'button' : undefined}
      tabIndex={onTap ? 0 : undefined}
      data-testid={testId}
      aria-pressed={onTap ? (selected ?? false) : undefined}
      onClick={onTap}
      onKeyDown={(event) => {
        if (onTap && (event.key === 'Enter' || event.key === ' ')) onTap()
      }}
      className={`flex w-56 shrink-0 flex-col overflow-hidden rounded-xl border bg-white text-left shadow-sm transition hover:shadow-md dark:bg-neutral-900 ${
        selected
          ? 'border-orange-600 ring-2 ring-orange-500'
          : status === 'selected'
            ? 'border-sky-600 ring-2 ring-sky-400'
            : 'border-neutral-200 dark:border-neutral-800'
      }`}
    >
      {photoUrl ? (
        <img src={photoUrl} alt={name} className="h-32 w-full object-cover" />
      ) : (
        <div className="flex h-32 w-full items-center justify-center bg-neutral-100 text-2xl dark:bg-neutral-800">
          <span aria-hidden>📷</span>
        </div>
      )}
      <div className="flex flex-1 flex-col gap-1.5 p-3">
        <p className="text-sm leading-snug font-semibold text-neutral-900 dark:text-white">
          {name}
        </p>
        {(category || rating != null) && (
          <div className="flex flex-wrap items-center gap-1.5">
            {category && <span className="chip chip-neutral">{category}</span>}
            {rating != null && (
              <span className="text-xs font-medium text-neutral-700 dark:text-neutral-200">
                <span aria-hidden className="text-amber-500">
                  ★
                </span>{' '}
                {rating.toFixed(1)}
                {ratingCount != null && (
                  <span className="font-normal text-neutral-500 dark:text-neutral-400">
                    {' '}
                    ({ratingCount})
                  </span>
                )}
              </span>
            )}
          </div>
        )}
        <p className="text-xs leading-relaxed text-neutral-600 dark:text-neutral-300">
          {blurb}
        </p>
        {googleMapsUrl && (
          <a
            data-testid={`${testId}-navigate`}
            href={googleMapsUrl}
            target="_blank"
            rel="noreferrer"
            onClick={stop}
            className="link mt-0.5 text-xs font-medium"
          >
            Navigate
          </a>
        )}

        {(onToggleSelected || onMarkDone || onMarkSkipped) && (
          <div className="mt-auto border-t border-neutral-100 pt-2 dark:border-neutral-800">
            <p
              data-testid={`${testId}-status`}
              className="text-xs text-neutral-500 dark:text-neutral-400"
            >
              Status: {status ?? 'suggested'}
            </p>
            {addingNote ? (
              <div onClick={stop} className="mt-1.5 flex flex-col gap-1.5">
                <textarea
                  data-testid={`${testId}-note-input`}
                  className="field field-sm text-xs"
                  placeholder="Optional note…"
                  value={noteDraft}
                  onChange={(event) => setNoteDraft(event.target.value)}
                />
                <button
                  type="button"
                  data-testid={`${testId}-confirm-done`}
                  className="btn btn-sm btn-primary"
                  onClick={() => {
                    onMarkDone?.(noteDraft)
                    setAddingNote(false)
                  }}
                >
                  Confirm done
                </button>
              </div>
            ) : (
              <div className="mt-1.5 flex flex-wrap gap-1.5">
                {onToggleSelected && (
                  <button
                    type="button"
                    data-testid={`${testId}-mark-selected`}
                    onClick={(event) => {
                      stop(event)
                      onToggleSelected()
                    }}
                    className="btn btn-sm btn-secondary"
                  >
                    {status === 'selected' ? 'Unselect' : 'Select'}
                  </button>
                )}
                {onMarkDone && (
                  <button
                    type="button"
                    data-testid={`${testId}-mark-done`}
                    onClick={(event) => {
                      stop(event)
                      setAddingNote(true)
                    }}
                    className="btn btn-sm btn-secondary"
                  >
                    Done
                  </button>
                )}
                {onMarkSkipped && (
                  <button
                    type="button"
                    data-testid={`${testId}-mark-skipped`}
                    onClick={(event) => {
                      stop(event)
                      onMarkSkipped()
                    }}
                    className="btn btn-sm btn-secondary text-neutral-500 dark:text-neutral-400"
                  >
                    Skip
                  </button>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
