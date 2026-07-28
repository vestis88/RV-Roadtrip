import { useState } from 'react'
import { httpsCallable } from 'firebase/functions'
import type { OvernightStopCandidate, Trip, TripDay } from '@rv/shared'
import { functions } from '../lib/firebase'
import { googleMapsSearchUrl } from '../lib/mapLinks'
import { submitPlanChangeRequest } from '../lib/submitChangeRequest'

interface OvernightCandidatesPickerProps {
  tripId: string
  trip: Trip
  dayId: string
  day: TripDay
  /** ids of every day before this one — locked so only this day (and, via
   * the replan, everything after it) gets re-planned. */
  priorDayIds: string[]
}

const WILD_TOOLTIP_SEEN_KEY = 'wildCampingTooltipSeen'

const GROUPS: { type: OvernightStopCandidate['type']; label: string }[] = [
  { type: 'campsite', label: 'Campsites' },
  { type: 'stellplatz', label: 'Stellplatz / motorhome parking' },
  { type: 'wild', label: 'Wild camping' },
]

/**
 * Overnight-stop type & candidate selection (implemented 2026-07-27):
 * candidates are resolved lazily, only when this panel is opened, and
 * picking one doesn't patch TripDay.overnight directly — that would leave
 * every following day's drive leg silently stale. Instead it submits a
 * scoped replan (reusing submitPlanChangeRequest, the same path Day View's
 * "Request changes for this day" uses) locking every day before this one,
 * with the chosen stop passed in as a hard constraint.
 */
export function OvernightCandidatesPicker({
  tripId,
  trip,
  dayId,
  day,
  priorDayIds,
}: OvernightCandidatesPickerProps) {
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [candidates, setCandidates] = useState<OvernightStopCandidate[] | null>(
    null,
  )
  const [submittingIndex, setSubmittingIndex] = useState<number | null>(null)
  const [showWildTooltip, setShowWildTooltip] = useState(
    () =>
      typeof window !== 'undefined' &&
      !window.localStorage.getItem(WILD_TOOLTIP_SEEN_KEY),
  )
  // Candidates are resolved fresh every time this panel opens, never
  // persisted — so unlike Day View's activity/restaurant Skip, there's
  // nothing to write to Firestore. Skipping here just dismisses a candidate
  // from view for this browsing session, reversibly, via the same
  // hide-behind-a-toggle pattern DayViewScreen's PlaceCardSection uses.
  const [skippedIndices, setSkippedIndices] = useState<Set<number>>(new Set())
  const [expandedSkippedTypes, setExpandedSkippedTypes] = useState<
    Set<OvernightStopCandidate['type']>
  >(new Set())

  function skipCandidate(index: number) {
    setSkippedIndices((prev) => new Set(prev).add(index))
  }

  function toggleShowSkipped(type: OvernightStopCandidate['type']) {
    setExpandedSkippedTypes((prev) => {
      const next = new Set(prev)
      if (next.has(type)) next.delete(type)
      else next.add(type)
      return next
    })
  }

  async function loadCandidates() {
    setOpen(true)
    if (candidates || loading) return
    setLoading(true)
    setError(null)
    try {
      const call = httpsCallable<
        { tripId: string; dayId: string },
        { candidates: OvernightStopCandidate[] }
      >(functions, 'getOvernightCandidates')
      const result = await call({ tripId, dayId })
      setCandidates(result.data.candidates)
    } catch (err) {
      console.error('getOvernightCandidates failed', err)
      setError('Could not load overnight options right now.')
    } finally {
      setLoading(false)
    }
  }

  function dismissWildTooltip() {
    setShowWildTooltip(false)
    window.localStorage.setItem(WILD_TOOLTIP_SEEN_KEY, '1')
  }

  async function pickCandidate(
    candidate: OvernightStopCandidate,
    index: number,
  ) {
    setSubmittingIndex(index)
    setError(null)
    try {
      await submitPlanChangeRequest(
        tripId,
        trip,
        `Change the overnight stop for Day ${day.index + 1} to "${candidate.name}" ` +
          `(${candidate.type}) at approximately ${candidate.lat.toFixed(4)}, ` +
          `${candidate.lng.toFixed(4)} — ${candidate.description}. Replan the ` +
          `route to continue from there.`,
        priorDayIds,
      )
      setOpen(false)
      setCandidates(null)
    } catch (err) {
      console.error('Failed to submit overnight change', err)
      setError('Could not submit that change — try again.')
    } finally {
      setSubmittingIndex(null)
    }
  }

  if (!open) {
    return (
      <div className="mx-4 mt-2">
        <button
          type="button"
          data-testid="change-overnight-toggle"
          onClick={loadCandidates}
          className="btn btn-sm btn-ghost -ml-3"
        >
          Change overnight stop
        </button>
      </div>
    )
  }

  return (
    <div
      data-testid="overnight-candidates-panel"
      className="card mx-4 mt-2 space-y-3 p-3"
    >
      {loading && (
        <p
          data-testid="overnight-candidates-loading"
          className="text-sm text-neutral-500 dark:text-neutral-400"
        >
          Looking for overnight options…
        </p>
      )}
      {error && (
        <p
          data-testid="overnight-candidates-error"
          className="text-sm text-red-600 dark:text-red-400"
        >
          {error}
        </p>
      )}

      {candidates &&
        GROUPS.map(({ type, label }) => {
          const allItems = candidates
            .map((c, i) => ({ c, i }))
            .filter(({ c }) => c.type === type)
          if (allItems.length === 0) return null
          const skipped = allItems.filter(({ i }) => skippedIndices.has(i))
          const showSkipped = expandedSkippedTypes.has(type)
          const items = showSkipped
            ? allItems
            : allItems.filter(({ i }) => !skippedIndices.has(i))
          return (
            <div key={type} data-testid={`overnight-group-${type}`}>
              <h3 className="text-sm font-semibold text-neutral-900 dark:text-white">
                {label}
              </h3>
              {type === 'stellplatz' && (
                <p className="text-xs text-neutral-400 dark:text-neutral-500">
                  Location data from{' '}
                  <a
                    href="https://www.openstreetmap.org/copyright"
                    target="_blank"
                    rel="noreferrer"
                    className="underline"
                  >
                    OpenStreetMap
                  </a>{' '}
                  contributors, under the Open Database License.
                </p>
              )}
              {type === 'wild' && showWildTooltip && (
                <p
                  data-testid="wild-camping-caveat"
                  className="mt-1 rounded-lg bg-amber-50 p-2 text-xs text-amber-900 dark:bg-amber-950 dark:text-amber-100"
                >
                  Wild camping legality varies a lot by country and region —
                  verify locally before relying on any of these.{' '}
                  <button
                    type="button"
                    data-testid="wild-camping-caveat-dismiss"
                    onClick={dismissWildTooltip}
                    className="underline"
                  >
                    Got it
                  </button>
                </p>
              )}
              <div className="mt-1 flex flex-col gap-2">
                {items.map(({ c, i }) => (
                  <div
                    key={i}
                    data-testid={`overnight-candidate-${type}-${i}`}
                    className={`surface rounded-lg border border-neutral-200 p-2 text-sm dark:border-neutral-800 ${
                      skippedIndices.has(i) ? 'opacity-60' : ''
                    }`}
                  >
                    <p className="font-medium text-neutral-900 dark:text-white">
                      {c.name}
                    </p>
                    <p className="text-xs text-neutral-600 dark:text-neutral-300">
                      {c.description}
                    </p>
                    {c.source === 'claude' && (
                      <p className="text-xs italic text-neutral-400 dark:text-neutral-500">
                        AI-suggested — verify locally.
                      </p>
                    )}
                    <a
                      data-testid={`overnight-candidate-navigate-${type}-${i}`}
                      href={c.googleMapsUrl ?? googleMapsSearchUrl(c.lat, c.lng)}
                      target="_blank"
                      rel="noreferrer"
                      className="link mt-1 inline-block text-xs font-medium"
                    >
                      Navigate
                    </a>
                    <div className="mt-2 flex flex-wrap items-center gap-2">
                      <button
                        type="button"
                        data-testid={`overnight-candidate-pick-${type}-${i}`}
                        disabled={submittingIndex !== null}
                        onClick={() => pickCandidate(c, i)}
                        className="btn btn-sm btn-primary"
                      >
                        {submittingIndex === i ? 'Submitting…' : 'Use this stop'}
                      </button>
                      {!skippedIndices.has(i) && (
                        <button
                          type="button"
                          data-testid={`overnight-candidate-skip-${type}-${i}`}
                          disabled={submittingIndex !== null}
                          onClick={() => skipCandidate(i)}
                          className="text-xs text-neutral-500 underline underline-offset-2 dark:text-neutral-400"
                        >
                          Skip
                        </button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
              {skipped.length > 0 && (
                <button
                  type="button"
                  data-testid={`overnight-group-${type}-show-skipped`}
                  onClick={() => toggleShowSkipped(type)}
                  className="mt-1 text-xs text-neutral-500 underline underline-offset-2 dark:text-neutral-400"
                >
                  {showSkipped ? 'Hide' : 'Show'} {skipped.length} skipped
                </button>
              )}
            </div>
          )
        })}

      {candidates && candidates.length === 0 && (
        <p
          data-testid="overnight-candidates-empty"
          className="text-sm text-neutral-500 dark:text-neutral-400"
        >
          No overnight options found nearby.
        </p>
      )}

      <button
        type="button"
        data-testid="change-overnight-cancel"
        onClick={() => setOpen(false)}
        className="btn btn-sm btn-secondary"
      >
        Cancel
      </button>
    </div>
  )
}
