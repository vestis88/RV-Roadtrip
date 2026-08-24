import { useState } from 'react'
import type { ActivityTimeOfDay, ItemStatus } from '@rv/shared'

const TIME_OF_DAY_OPTIONS: { value: ActivityTimeOfDay; label: string }[] = [
  { value: 'morning', label: 'Morning' },
  { value: 'evening', label: 'Evening' },
  { value: 'night', label: 'Night' },
  { value: 'all-day', label: 'All day' },
]

interface PlaceCardProps {
  testId: string
  name: string
  category?: string
  rating?: number
  ratingCount?: number
  blurb: string
  /**
   * This is not the place the plan named — Places couldn't find that one (or
   * the traveler asked for more options than were planned), so this is the
   * best-rated thing of its kind nearby instead.
   *
   * Worth a chip of its own because the card otherwise reads identically to
   * a curated pick, which is how a shopping centre passed for "Charming
   * lakeside café near the castle". The blurb is generic now, but a generic
   * blurb alone doesn't tell the traveler WHY it's generic.
   */
  substitute?: boolean
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
  /**
   * A status change for this row's scope is already in flight. Every action
   * below can trigger a requeue — which may spend a paid Places/Claude call
   * to refill the pool — so a double-tap could consume two reserve items or
   * fire that call twice for one intended action.
   */
  busy?: boolean
  /** Activities only (never passed for restaurants, which already have a
   * fixed `meal`) — absent `timeOfDay` reads as 'all-day'. Only shown once
   * selected: picking a time of day is meaningless for something not even
   * committed to yet, and the day route treats every unselected item the
   * same regardless. */
  timeOfDay?: ActivityTimeOfDay
  onSetTimeOfDay?: (timeOfDay: ActivityTimeOfDay) => void
}

export function PlaceCard({
  testId,
  name,
  category,
  rating,
  ratingCount,
  blurb,
  substitute,
  photoUrl,
  googleMapsUrl,
  selected,
  onTap,
  status,
  onToggleSelected,
  onMarkDone,
  onMarkSkipped,
  busy = false,
  timeOfDay,
  onSetTimeOfDay,
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
        // Same guard as ExploreCandidateCard, for the same reason. This card
        // holds no fields today, so nothing is broken — but it is the same
        // `role="button"` wrapper, and the day it gains one, a space typed
        // into it would toggle the card's selection instead.
        if (event.target !== event.currentTarget) return
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
        {(category || substitute || rating != null) && (
          <div className="flex flex-wrap items-center gap-1.5">
            {category && <span className="chip chip-neutral">{category}</span>}
            {substitute && (
              <span
                data-testid={`${testId}-substitute`}
                className="chip chip-amber"
                title="Not one of the plan's own suggestions — the best-rated place of this kind we could find nearby."
              >
                Top-rated nearby
              </span>
            )}
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
                  className="field field-sm"
                  placeholder="Optional note…"
                  value={noteDraft}
                  onChange={(event) => setNoteDraft(event.target.value)}
                />
                <div className="flex gap-1.5">
                  <button
                    type="button"
                    data-testid={`${testId}-confirm-done`}
                    className="btn btn-sm btn-primary"
                    disabled={busy}
                    onClick={() => {
                      onMarkDone?.(noteDraft)
                      setAddingNote(false)
                    }}
                  >
                    Confirm done
                  </button>
                  {/* Tapping "Done" by mistake used to be a dead end: the
                      button row was replaced by this note field with no way
                      back short of reloading. */}
                  <button
                    type="button"
                    data-testid={`${testId}-cancel-done`}
                    className="btn btn-sm btn-secondary"
                    onClick={() => {
                      setAddingNote(false)
                      setNoteDraft('')
                    }}
                  >
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <div className="mt-1.5 flex flex-wrap gap-1.5">
                {onToggleSelected && (
                  <button
                    type="button"
                    data-testid={`${testId}-mark-selected`}
                    disabled={busy}
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
                    disabled={busy}
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
                    disabled={busy}
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
            {onSetTimeOfDay && status === 'selected' && (
              <div
                onClick={stop}
                className="mt-1.5 flex flex-wrap gap-1"
                data-testid={`${testId}-time-of-day`}
              >
                {TIME_OF_DAY_OPTIONS.map((option) => {
                  const active = (timeOfDay ?? 'all-day') === option.value
                  return (
                    <button
                      key={option.value}
                      type="button"
                      data-testid={`${testId}-time-of-day-${option.value}`}
                      aria-pressed={active}
                      onClick={() => onSetTimeOfDay(option.value)}
                      className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${
                        active
                          ? 'bg-orange-600 text-white'
                          : 'bg-neutral-100 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300'
                      }`}
                    >
                      {option.label}
                    </button>
                  )
                })}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
