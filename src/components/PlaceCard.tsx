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
  onMarkSelected?: () => void
  onMarkDone?: (note: string) => void
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
  onMarkSelected,
  onMarkDone,
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
      aria-pressed={onTap ? selected ?? false : undefined}
      onClick={onTap}
      onKeyDown={(event) => {
        if (onTap && (event.key === 'Enter' || event.key === ' ')) onTap()
      }}
      className={`flex w-56 shrink-0 flex-col overflow-hidden rounded-lg border bg-white text-left shadow-sm dark:bg-neutral-900 ${
        selected
          ? 'border-orange-600 ring-2 ring-orange-600'
          : 'border-neutral-200 dark:border-neutral-800'
      }`}
    >
      {photoUrl ? (
        <img src={photoUrl} alt={name} className="h-28 w-full object-cover" />
      ) : (
        <div className="h-28 w-full bg-neutral-100 dark:bg-neutral-800" />
      )}
      <div className="flex flex-1 flex-col gap-1 p-3">
        <p className="text-sm font-semibold text-neutral-900 dark:text-white">
          {name}
        </p>
        {category && (
          <p className="text-xs uppercase text-neutral-500 dark:text-neutral-400">
            {category}
          </p>
        )}
        {rating != null && (
          <p className="text-xs text-neutral-600 dark:text-neutral-300">
            ★ {rating.toFixed(1)} {ratingCount != null && `(${ratingCount})`}
          </p>
        )}
        <p className="text-xs text-neutral-600 dark:text-neutral-300">{blurb}</p>
        {googleMapsUrl && (
          <a
            data-testid={`${testId}-navigate`}
            href={googleMapsUrl}
            target="_blank"
            rel="noreferrer"
            onClick={stop}
            className="mt-1 text-xs font-medium text-orange-700 underline dark:text-orange-400"
          >
            Navigate
          </a>
        )}

        {(onMarkSelected || onMarkDone) && (
          <div className="mt-2 border-t border-neutral-100 pt-2 dark:border-neutral-800">
            <p
              data-testid={`${testId}-status`}
              className="text-xs text-neutral-500 dark:text-neutral-400"
            >
              Status: {status ?? 'suggested'}
            </p>
            {addingNote ? (
              <div onClick={stop} className="mt-1 flex flex-col gap-1">
                <textarea
                  data-testid={`${testId}-note-input`}
                  className="w-full rounded border border-neutral-300 p-1 text-xs dark:border-neutral-700 dark:bg-neutral-800 dark:text-white"
                  placeholder="Optional note…"
                  value={noteDraft}
                  onChange={(event) => setNoteDraft(event.target.value)}
                />
                <button
                  type="button"
                  data-testid={`${testId}-confirm-done`}
                  className="rounded bg-orange-600 px-2 py-1 text-xs text-white"
                  onClick={() => {
                    onMarkDone?.(noteDraft)
                    setAddingNote(false)
                  }}
                >
                  Confirm done
                </button>
              </div>
            ) : (
              <div className="mt-1 flex gap-2">
                {onMarkSelected && (
                  <button
                    type="button"
                    data-testid={`${testId}-mark-selected`}
                    onClick={(event) => {
                      stop(event)
                      onMarkSelected()
                    }}
                    className="rounded border border-neutral-300 px-2 py-1 text-xs text-neutral-900 dark:border-neutral-700 dark:text-white"
                  >
                    Select
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
                    className="rounded border border-neutral-300 px-2 py-1 text-xs text-neutral-900 dark:border-neutral-700 dark:text-white"
                  >
                    Done
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
