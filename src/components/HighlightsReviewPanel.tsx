import { useRef, useState } from 'react'
import { addDoc, collection, serverTimestamp } from 'firebase/firestore'
import { db } from '../lib/firebase'

type Priority = 'must-see' | 'worth-a-detour' | 'nice-if-convenient'

interface CandidateStop {
  town: string
  country: string
  why: string
  priority: Priority
}

interface RegionHighlight {
  region: string
  country: string
  reasoning: string
  candidateStops: CandidateStop[]
}

interface RegionHighlightsResponse {
  regions: RegionHighlight[]
}

interface HighlightsReviewPanelProps {
  tripId: string
  pendingHighlights: unknown
}

// Low to high — "up" promotes a candidate toward must-see, "down" demotes it
// toward nice-if-convenient. This is the field OUTLINE_SYSTEM_PROMPT actually
// reasons over (functions/src/prompts/planTripPrompt.ts), so it's the one
// control that meaningfully changes what the outline phase does with a stop.
const PRIORITY_TIERS: Priority[] = [
  'nice-if-convenient',
  'worth-a-detour',
  'must-see',
]

const PRIORITY_LABEL: Record<Priority, string> = {
  'must-see': 'Must-see',
  'worth-a-detour': 'Worth a detour',
  'nice-if-convenient': 'Nice if convenient',
}

/**
 * Interactive/transparent route planning's review pause (implemented
 * 2026-07-27): the highlights phase already produces exactly the data this
 * surfaces — ranked candidate stops per region with a reasoning string —
 * previously never shown to the traveler. Editing here (re-rank, remove, a
 * free-text note) reshapes the next phase's input; it doesn't touch the
 * outline/detail prompts themselves.
 */
export function HighlightsReviewPanel({
  tripId,
  pendingHighlights,
}: HighlightsReviewPanelProps) {
  const [highlights, setHighlights] = useState<RegionHighlightsResponse>(
    () => (pendingHighlights as RegionHighlightsResponse) ?? { regions: [] },
  )
  const [note, setNote] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const dragSource = useRef<{ regionIndex: number; stopIndex: number } | null>(
    null,
  )

  function updateRegionStops(
    regionIndex: number,
    updater: (stops: CandidateStop[]) => CandidateStop[],
  ) {
    setHighlights((prev) => ({
      regions: prev.regions.map((region, i) =>
        i === regionIndex
          ? { ...region, candidateStops: updater(region.candidateStops) }
          : region,
      ),
    }))
  }

  function movePriority(regionIndex: number, stopIndex: number, delta: 1 | -1) {
    updateRegionStops(regionIndex, (stops) =>
      stops.map((stop, i) => {
        if (i !== stopIndex) return stop
        const tierIndex = PRIORITY_TIERS.indexOf(stop.priority)
        const nextTier = PRIORITY_TIERS[tierIndex + delta]
        return nextTier ? { ...stop, priority: nextTier } : stop
      }),
    )
  }

  function removeStop(regionIndex: number, stopIndex: number) {
    updateRegionStops(regionIndex, (stops) =>
      stops.filter((_, i) => i !== stopIndex),
    )
  }

  function reorderStop(
    regionIndex: number,
    fromIndex: number,
    toIndex: number,
  ) {
    updateRegionStops(regionIndex, (stops) => {
      const next = [...stops]
      const [moved] = next.splice(fromIndex, 1)
      next.splice(toIndex, 0, moved)
      return next
    })
  }

  async function submit() {
    setSubmitting(true)
    setError(null)
    try {
      await addDoc(collection(db, 'planRequests'), {
        tripId,
        kind: 'continueFromHighlights',
        editedHighlights: highlights,
        ...(note.trim() ? { reviewNote: note.trim() } : {}),
        status: 'pending',
        createdAt: serverTimestamp(),
      })
    } catch (err) {
      console.error('Failed to submit continueFromHighlights request', err)
      setError('Could not continue generating right now — try again.')
      setSubmitting(false)
    }
  }

  return (
    <div
      data-testid="highlights-review-panel"
      className="space-y-4 rounded border border-neutral-200 p-4 dark:border-neutral-800"
    >
      <p className="text-sm text-neutral-600 dark:text-neutral-300">
        Here's what stood out region by region, before dates and pacing come
        into it. Re-rank or remove anything before generating the full route.
      </p>

      {highlights.regions.map((region, regionIndex) => (
        <div
          key={regionIndex}
          data-testid={`highlights-region-${regionIndex}`}
          className="space-y-2"
        >
          <h3 className="font-medium text-neutral-900 dark:text-white">
            {region.region}
          </h3>
          <p className="text-xs text-neutral-500 dark:text-neutral-400">
            {region.reasoning}
          </p>
          <div className="space-y-1">
            {region.candidateStops.map((stop, stopIndex) => (
              <div
                key={stopIndex}
                draggable
                data-testid={`highlights-stop-${regionIndex}-${stopIndex}`}
                onDragStart={() => {
                  dragSource.current = { regionIndex, stopIndex }
                }}
                onDragOver={(event) => event.preventDefault()}
                onDrop={(event) => {
                  event.preventDefault()
                  const source = dragSource.current
                  dragSource.current = null
                  if (!source || source.regionIndex !== regionIndex) return
                  reorderStop(regionIndex, source.stopIndex, stopIndex)
                }}
                className="flex items-center gap-2 rounded border border-neutral-200 bg-white p-2 text-sm dark:border-neutral-800 dark:bg-neutral-900"
              >
                <span
                  aria-hidden
                  className="cursor-grab text-neutral-400 select-none"
                >
                  ⠿
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium text-neutral-900 dark:text-white">
                    {stop.town}
                  </p>
                  <p className="truncate text-xs text-neutral-500 dark:text-neutral-400">
                    {stop.why}
                  </p>
                </div>
                <span
                  data-testid={`highlights-stop-priority-${regionIndex}-${stopIndex}`}
                  className="shrink-0 rounded bg-neutral-100 px-2 py-0.5 text-xs text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300"
                >
                  {PRIORITY_LABEL[stop.priority]}
                </span>
                <div className="flex shrink-0 flex-col">
                  <button
                    type="button"
                    aria-label="Raise priority"
                    data-testid={`highlights-stop-up-${regionIndex}-${stopIndex}`}
                    disabled={stop.priority === 'must-see'}
                    onClick={() => movePriority(regionIndex, stopIndex, 1)}
                    className="px-1 text-xs text-neutral-500 disabled:opacity-30 dark:text-neutral-400"
                  >
                    ▲
                  </button>
                  <button
                    type="button"
                    aria-label="Lower priority"
                    data-testid={`highlights-stop-down-${regionIndex}-${stopIndex}`}
                    disabled={stop.priority === 'nice-if-convenient'}
                    onClick={() => movePriority(regionIndex, stopIndex, -1)}
                    className="px-1 text-xs text-neutral-500 disabled:opacity-30 dark:text-neutral-400"
                  >
                    ▼
                  </button>
                </div>
                <button
                  type="button"
                  data-testid={`highlights-stop-remove-${regionIndex}-${stopIndex}`}
                  onClick={() => removeStop(regionIndex, stopIndex)}
                  className="shrink-0 text-xs text-red-600 underline dark:text-red-400"
                >
                  Remove
                </button>
              </div>
            ))}
          </div>
        </div>
      ))}

      <label className="block">
        <span className="mb-1 block text-sm font-medium text-neutral-700 dark:text-neutral-300">
          Anything else to make sure gets included?
        </span>
        <textarea
          data-testid="highlights-review-note"
          className="w-full rounded border border-neutral-300 p-2 text-sm dark:border-neutral-700 dark:bg-neutral-800 dark:text-white"
          placeholder="e.g. must include a waterfall stop"
          value={note}
          onChange={(event) => setNote(event.target.value)}
        />
      </label>

      {error && (
        <p
          data-testid="highlights-review-error"
          className="text-sm text-red-600 dark:text-red-400"
        >
          {error}
        </p>
      )}

      <button
        type="button"
        data-testid="highlights-review-continue"
        disabled={submitting}
        onClick={submit}
        className="rounded bg-orange-600 px-4 py-2 text-white disabled:opacity-50"
      >
        {submitting ? 'Continuing…' : 'Continue generating'}
      </button>
    </div>
  )
}
