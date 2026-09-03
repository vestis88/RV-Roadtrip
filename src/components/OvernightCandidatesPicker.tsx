import { useState } from 'react'
import { collection, getDocs } from 'firebase/firestore'
import { httpsCallable } from 'firebase/functions'
import type { OvernightStopCandidate, TripDay } from '@rv/shared'
import { db, functions } from '../lib/firebase'
import { navigateUrl } from '../lib/mapLinks'
import { chooseOvernight } from '../lib/chooseOvernight'
import { LONG_CALLABLE_TIMEOUT_MS } from '../lib/callableTimeouts'

interface OvernightCandidatesPickerProps {
  tripId: string
  dayId: string
  day: TripDay
  /**
   * True while a full plan generation is rewriting the trip underneath this.
   *
   * Kept although choosing no longer submits anything: a generation in
   * flight owns the days and would overwrite a choice made while it ran.
   * `trip`, `priorDayIds` and `onSubmitted` went with the replan they
   * existed for.
   */
  planBusy: boolean
}

const WILD_TOOLTIP_SEEN_KEY = 'wildCampingTooltipSeen'

const GROUPS: { type: OvernightStopCandidate['type']; label: string }[] = [
  { type: 'campsite', label: 'Campsites' },
  { type: 'stellplatz', label: 'Stellplatz / motorhome parking' },
  { type: 'wild', label: 'Wild camping' },
]

/**
 * Overnight-stop type & candidate selection (2026-07-27): candidates are
 * resolved lazily, only when this panel is opened, and picking one writes
 * the choice onto the day immediately.
 *
 * It did not always. Until 2026-09-02 it submitted a scoped REPLAN —
 * *"picking one doesn't patch TripDay.overnight directly — that would leave
 * every following day's drive leg silently stale"* — so a chosen campsite
 * changed nothing until a Claude pass rewrote the rest of the trip, and with
 * the API account out of credit it changed nothing at all. Reported as *"I
 * went in to add alternative overnight stops… It was not saved."*
 *
 * The fear was real under a frozen plan and is obsolete under this one: the
 * days are re-derived from the board and their legs come from the live
 * Directions call. See chooseOvernight, and `townAnchor` for the part that
 * keeps the day recognisable to the writer that preserves it.
 */
export function OvernightCandidatesPicker({
  tripId,
  dayId,
  day,
  planBusy,
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

  /**
   * Options are resolved for every day when the plan is generated and stored
   * alongside it, the same way activities and restaurants are — so the
   * common case is a Firestore read of something already there, not a
   * multi-source lookup across Places, Overpass and Claude while someone
   * watches a spinner. That lookup is what used to sit here, and what used
   * to time out.
   */
  async function loadCandidates() {
    setOpen(true)
    if (candidates || loading) return
    setLoading(true)
    setError(null)
    try {
      const stored = await getDocs(
        collection(db, 'trips', tripId, 'days', dayId, 'overnightOptions'),
      )
      if (!stored.empty) {
        setCandidates(stored.docs.map((doc) => doc.data() as OvernightStopCandidate))
        return
      }
      // Nothing stored: a trip generated before options were resolved up
      // front, or a day added since. Fall back to resolving this one day
      // live — the same call this used to make every time.
      const call = httpsCallable<
        { tripId: string; dayId: string },
        { candidates: OvernightStopCandidate[] }
      >(functions, 'getOvernightCandidates', { timeout: LONG_CALLABLE_TIMEOUT_MS })
      const result = await call({ tripId, dayId })
      setCandidates(result.data.candidates)
    } catch (err) {
      console.error('Loading overnight options failed', err)
      setError('Could not load overnight options right now.')
    } finally {
      setLoading(false)
    }
  }

  function dismissWildTooltip() {
    setShowWildTooltip(false)
    window.localStorage.setItem(WILD_TOOLTIP_SEEN_KEY, '1')
  }

  /**
   * `submittingIndex` alone was the whole guard here, and it clears the
   * moment the Firestore write resolves. But the write is only the request:
   * generatePlan is a trigger on it, so the trip stays 'ready' for a second
   * or two afterwards. This panel closed, the buttons went live again, and a
   * second pick was accepted against a plan that was already being replaced
   * — reported 2026-08-13, a three-night trip returned as eight with the
   * route doubling back through towns it had already been through.
   * markSubmitted() below closes that window on this client (the server
   * closes it for good, and across devices, via planLock.ts's
   * wasSubmittedBeforeRunEnded — this is here so the traveler gets an
   * immediate answer instead of a rejected request).
   */
  async function pickCandidate(
    candidate: OvernightStopCandidate,
    index: number,
  ) {
    setSubmittingIndex(index)
    setError(null)
    try {
      // Written straight onto the day. See chooseOvernight for why this
      // stopped being a replan: the fear it was avoiding — stranding the
      // following days' drive legs — belongs to a plan that was frozen, and
      // this one is re-derived from the board.
      await chooseOvernight(tripId, dayId, day, candidate)
      setOpen(false)
      setCandidates(null)
    } catch (err) {
      console.error('Failed to save the overnight choice', err)
      setError('Could not save that — try again.')
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
          disabled={planBusy}
          onClick={loadCandidates}
          className="btn btn-sm btn-ghost -ml-3 disabled:opacity-40"
        >
          {planBusy ? 'Updating the plan…' : 'Change overnight stop'}
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
                      href={navigateUrl(c)}
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
                        disabled={submittingIndex !== null || planBusy}
                        onClick={() => pickCandidate(c, i)}
                        className="btn btn-sm btn-primary disabled:opacity-40"
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
