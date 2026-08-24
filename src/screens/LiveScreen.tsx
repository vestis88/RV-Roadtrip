import { useState } from 'react'
import { addDoc, collection } from 'firebase/firestore'
import { useTripContext } from '../context/TripContext'
import { useCurrentPosition } from '../hooks/useCurrentPosition'
import { db } from '../lib/firebase'
import {
  LIVE_PRESETS,
  searchAroundUs,
  type LiveFind,
} from '../lib/liveSearch'
import { describeExploreHighlightsError } from '../lib/exploreCandidateActions'
import { isoCountryFlag } from '../lib/countryFlag'

/**
 * What's around us, right now.
 *
 * Requested 2026-08-23: "a live function, which is basically find things
 * around us now. The input should be the already predetermined ones from
 * detailed planning (breakfast/lunch/dinner/activity, but also free text).
 * The notes should be taken as input for each."
 *
 * Two things make this different from every other search in the app, and
 * both are deliberate:
 *
 *  - **It is anchored to the van, not to the map.** No panning, no circle to
 *    aim: the question is about here.
 *  - **It writes nothing.** Results are a scratch list for the next hour.
 *    Someone looking for lunch three times a day would otherwise fill their
 *    corridor with two hundred pins they never chose, which is the opposite
 *    of curation. "Add to trip" is the only thing that saves one, and it
 *    saves it as an ordinary candidate for the board to deal with later.
 *
 * The trip's notes and interests reach the search server-side, so "cozy over
 * mainstream" means the same thing from a lay-by as it does in planning.
 */
export function LiveScreen() {
  const { tripId, trip } = useTripContext()
  const { position, denied } = useCurrentPosition()
  const [busy, setBusy] = useState<string | null>(null)
  const [finds, setFinds] = useState<LiveFind[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [freeText, setFreeText] = useState('')
  const [added, setAdded] = useState<Set<string>>(new Set())

  async function run(id: string, query: string) {
    if (!position) return
    setBusy(id)
    setError(null)
    setFinds(null)
    try {
      setFinds(await searchAroundUs(tripId, position, query))
    } catch (err) {
      console.error('Live search failed', err)
      setError(describeExploreHighlightsError(err))
    } finally {
      setBusy(null)
    }
  }

  /** Saved as an ordinary candidate — the board decides what happens next. */
  async function addToTrip(find: LiveFind) {
    setAdded((held) => new Set(held).add(find.name))
    try {
      await addDoc(collection(db, 'trips', tripId, 'corridorStops'), {
        name: find.name,
        lat: find.lat,
        lng: find.lng,
        country: find.country,
        why: find.why,
        ...(find.googleMapsUrl ? { googleMapsUrl: find.googleMapsUrl } : {}),
        ...(find.photoUrl ? { photoUrl: find.photoUrl } : {}),
        status: 'candidate',
        linkedDayIds: [],
        priority: 'worth-a-detour',
        rank: 0,
        // Found because the traveler went looking, from the road.
        origin: 'traveler',
      })
    } catch (err) {
      console.error('Adding a live find failed', err)
      setAdded((held) => {
        const next = new Set(held)
        next.delete(find.name)
        return next
      })
      setError('Could not add that to the trip — please try again.')
    }
  }

  return (
    <div className="flex h-full w-full flex-col" data-testid="live-screen">
      <div className="surface flex flex-wrap gap-2 border-b border-neutral-200 px-3 py-2 dark:border-neutral-800">
        {LIVE_PRESETS.map((preset) => (
          <button
            key={preset.id}
            type="button"
            data-testid={`live-preset-${preset.id}`}
            className="btn btn-sm btn-secondary disabled:opacity-40"
            disabled={!position || busy !== null}
            onClick={() => void run(preset.id, preset.query)}
          >
            {busy === preset.id ? 'Looking…' : preset.label}
          </button>
        ))}
      </div>

      <form
        className="flex gap-2 border-b border-neutral-200 px-3 py-2 dark:border-neutral-800"
        onSubmit={(event) => {
          event.preventDefault()
          if (freeText.trim()) void run('free', freeText.trim())
        }}
      >
        <input
          data-testid="live-free-text"
          className="field flex-1"
          placeholder="or describe it — “a playground”, “a quiet spot by water”"
          value={freeText}
          onChange={(event) => setFreeText(event.target.value)}
        />
        <button
          type="submit"
          data-testid="live-search-button"
          className="btn btn-primary disabled:opacity-40"
          disabled={!position || busy !== null || !freeText.trim()}
        >
          Search
        </button>
      </form>

      {denied && (
        <p
          data-testid="live-permission-denied"
          className="border-b border-amber-300 bg-amber-50 p-2 text-center text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-100"
        >
          This needs your location to know what &ldquo;here&rdquo; means.
          Allow it in your browser settings and come back.
        </p>
      )}
      {!position && !denied && (
        <p
          data-testid="live-locating"
          className="p-3 text-center text-sm text-neutral-500 dark:text-neutral-400"
        >
          Finding where you are…
        </p>
      )}
      {error && (
        <p data-testid="live-error" className="p-3 text-sm text-red-600">
          {error}
        </p>
      )}

      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-3">
        {finds?.length === 0 && (
          <p
            data-testid="live-empty"
            className="text-sm text-neutral-500 dark:text-neutral-400"
          >
            Nothing found around here for that. Try a different wording, or
            drive on a bit.
          </p>
        )}
        {finds?.map((find) => (
          <div key={find.name} className="card p-3" data-testid="live-find">
            <p className="text-sm font-medium text-neutral-900 dark:text-white">
              {find.name} {isoCountryFlag(find.country)}
            </p>
            <p className="mt-1 text-xs leading-relaxed text-neutral-600 dark:text-neutral-300">
              {find.why}
            </p>
            <div className="mt-2 flex gap-2">
              <button
                type="button"
                data-testid={`live-add-${find.name}`}
                className="btn btn-sm btn-secondary disabled:opacity-40"
                disabled={added.has(find.name)}
                onClick={() => void addToTrip(find)}
              >
                {added.has(find.name) ? 'Added' : 'Add to trip'}
              </button>
              {find.googleMapsUrl && (
                <a
                  className="btn btn-sm btn-ghost"
                  href={find.googleMapsUrl}
                  target="_blank"
                  rel="noreferrer"
                >
                  Open in Maps
                </a>
              )}
            </div>
          </div>
        ))}
      </div>
      {/* Nothing above is saved. Said out loud, because every other search in
        * this app writes what it finds. */}
      {finds && finds.length > 0 && (
        <p
          data-testid="live-ephemeral-note"
          className="border-t border-neutral-200 p-2 text-center text-xs text-neutral-500 dark:border-neutral-800 dark:text-neutral-400"
        >
          These aren&rsquo;t saved — tap Add to trip to keep one. {trip.meta.name}
        </p>
      )}
    </div>
  )
}

export default LiveScreen
