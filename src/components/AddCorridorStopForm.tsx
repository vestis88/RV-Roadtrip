import { useState } from 'react'
import { addDoc, collection } from 'firebase/firestore'
import { corridorStopSchema, type LatLng, type NamedPoint } from '@rv/shared'
import { db } from '../lib/firebase'
import { RESCAN_RADIUS_KM, rescanCorridorArea } from '../lib/rescanCorridorAction'
import { PlaceAutocompleteInput } from './PlaceAutocompleteInput'

interface AddCorridorStopFormProps {
  tripId: string
  defaultLocation: NamedPoint
  // The explore-mode route corridor (start -> locked stops -> end, in route
  // order) — passed only from ExploreMapScreen, where it's already computed
  // for the candidate list's own detour badges (buildRouteBackbone). When
  // given, "Describe it" mode searches along this whole route instead of
  // just near the map's current center — see its own doc comment below.
  // Undefined from OverviewMapScreen (post-generation editing has no
  // equivalent "locked candidates" corridor), where search stays point-scoped.
  backbone?: LatLng[]
}

type Mode = 'place' | 'search'

/**
 * A traveler pinning a stop on the corridor directly — same
 * client-direct-write philosophy as AddCustomStopForm, writing straight to
 * `corridorStops` with no callable involved. Status starts at 'locked', not
 * 'proposed': typing a stop in here is a deliberate choice, the same reason
 * AddCustomStopForm writes `status: 'selected'` immediately rather than
 * 'suggested'. `linkedDayIds` starts empty — reconciling it into an actual
 * day is phase 4's job.
 *
 * "Describe what you want" mode (2026-08-01): the Google Places autocomplete
 * above only works when the traveler already knows the exact place they
 * want by name — "find me a coffee stop along the route" or "a cozy small
 * lunch place near here" has no name to type. This mode instead reuses the
 * same rescanCorridor pipeline "Rescan this area" already runs (Claude +
 * web search), just with the traveler's own free-text query steering what
 * it looks for instead of the generic "what's worth stopping for" pass, and
 * — when `backbone` is available — searching along the whole route corridor
 * rather than just one map-center point, so "coffee stop along route"
 * actually means the route. Results land as `proposed`/`candidate`
 * corridorStops on the map for review, exactly like a plain rescan — no
 * separate results list here, same "the map is the results view"
 * philosophy RescanCorridorButton already established. A `candidate` result
 * picks up the same detour badge every other explore-mode candidate already
 * gets (ExploreMapScreen computes it uniformly for every entry in its
 * candidate list) — nothing extra needed here for that part.
 */
export function AddCorridorStopForm({
  tripId,
  defaultLocation,
  backbone,
}: AddCorridorStopFormProps) {
  const [open, setOpen] = useState(false)
  const [mode, setMode] = useState<Mode>('place')
  const [name, setName] = useState('')
  const [location, setLocation] = useState<NamedPoint>(defaultLocation)
  const [why, setWhy] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [query, setQuery] = useState('')
  const [searching, setSearching] = useState(false)
  const [searchStatus, setSearchStatus] = useState<string | null>(null)
  const [searchError, setSearchError] = useState<string | null>(null)

  function reset() {
    setName('')
    setLocation(defaultLocation)
    setWhy('')
    setQuery('')
    setSearchStatus(null)
    setSearchError(null)
  }

  async function submit() {
    setError(null)
    if (!name.trim()) {
      setError('Name is required.')
      return
    }
    setSubmitting(true)
    try {
      const stop = corridorStopSchema.parse({
        name: name.trim(),
        lat: location.lat,
        lng: location.lng,
        ...(why.trim() ? { why: why.trim() } : {}),
        status: 'locked',
        linkedDayIds: [],
      })
      await addDoc(collection(db, 'trips', tripId, 'corridorStops'), stop)
      reset()
      setOpen(false)
    } catch (err) {
      console.error('Failed to add corridor stop', err)
      setError('Could not add stop — double check the fields and try again.')
    } finally {
      setSubmitting(false)
    }
  }

  async function search() {
    setSearchError(null)
    if (!query.trim()) {
      setSearchError('Describe what you\'re looking for first.')
      return
    }
    setSearching(true)
    setSearchStatus(null)
    try {
      const result = await rescanCorridorArea(
        tripId,
        defaultLocation,
        RESCAN_RADIUS_KM,
        query.trim(),
        backbone,
      )
      setSearchStatus(
        result.stopsWritten > 0
          ? `Found ${result.stopsWritten} new stop${result.stopsWritten === 1 ? '' : 's'} nearby — check the map.`
          : 'Nothing matching that found nearby — try a different description.',
      )
    } catch (err) {
      console.error('rescanCorridor (query) failed', err)
      setSearchError('Could not search right now — please try again.')
    } finally {
      setSearching(false)
    }
  }

  if (!open) {
    return (
      <button
        type="button"
        data-testid="add-corridor-stop-toggle"
        // Seed the location from wherever the map is looking NOW. This form
        // stays mounted between uses (only `open` toggles), so `useState`
        // captured the map centre once at page load: pan somewhere else,
        // open this, submit without touching the Location field, and the
        // stop silently landed back at the original centre — a blank-looking
        // field quietly carrying stale coordinates.
        onClick={() => {
          setLocation(defaultLocation)
          setOpen(true)
        }}
        className="btn btn-sm border border-dashed border-neutral-300 bg-white/95 text-neutral-600 shadow-md backdrop-blur-sm hover:bg-neutral-100 dark:border-neutral-700 dark:bg-neutral-900/95 dark:text-neutral-300 dark:hover:bg-neutral-800"
      >
        + Add stop
      </button>
    )
  }

  return (
    <div
      data-testid="add-corridor-stop-form"
      className="card w-64 space-y-2 p-3 shadow-lg"
    >
      <div className="flex gap-1 rounded-full bg-neutral-100 p-0.5 text-xs dark:bg-neutral-800/60">
        <button
          type="button"
          data-testid="add-corridor-stop-mode-place"
          onClick={() => setMode('place')}
          aria-pressed={mode === 'place'}
          className={`flex-1 rounded-full px-2 py-1 font-medium ${
            mode === 'place'
              ? 'bg-white text-neutral-900 shadow-sm dark:bg-neutral-700 dark:text-white'
              : 'text-neutral-500 dark:text-neutral-400'
          }`}
        >
          Pick a place
        </button>
        <button
          type="button"
          data-testid="add-corridor-stop-mode-search"
          onClick={() => setMode('search')}
          aria-pressed={mode === 'search'}
          className={`flex-1 rounded-full px-2 py-1 font-medium ${
            mode === 'search'
              ? 'bg-white text-neutral-900 shadow-sm dark:bg-neutral-700 dark:text-white'
              : 'text-neutral-500 dark:text-neutral-400'
          }`}
        >
          Describe it
        </button>
      </div>

      {mode === 'place' ? (
        <>
          <label className="block">
            <span className="mb-1 block text-sm font-medium text-neutral-700 dark:text-neutral-300">
              Name
            </span>
            <input
              data-testid="corridor-stop-name"
              className="field field-sm"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="e.g. Rondane viewpoint"
            />
          </label>

          <PlaceAutocompleteInput
            label="Location"
            testId="corridor-stop-location"
            value={location}
            onChange={setLocation}
          />

          <label className="block">
            <span className="mb-1 block text-sm font-medium text-neutral-700 dark:text-neutral-300">
              Why (optional)
            </span>
            <input
              data-testid="corridor-stop-why"
              className="field field-sm"
              value={why}
              onChange={(event) => setWhy(event.target.value)}
            />
          </label>

          {error && (
            <p
              data-testid="corridor-stop-form-error"
              className="text-sm text-red-600 dark:text-red-400"
            >
              {error}
            </p>
          )}

          <div className="flex gap-2">
            <button
              type="button"
              data-testid="corridor-stop-submit"
              disabled={submitting}
              onClick={submit}
              className="btn btn-sm btn-primary"
            >
              Add stop
            </button>
            <button
              type="button"
              data-testid="corridor-stop-cancel"
              onClick={() => {
                reset()
                setOpen(false)
              }}
              className="btn btn-sm btn-secondary"
            >
              Cancel
            </button>
          </div>
        </>
      ) : (
        <>
          <label className="block">
            <span className="mb-1 block text-sm font-medium text-neutral-700 dark:text-neutral-300">
              What are you looking for?
            </span>
            <input
              data-testid="corridor-search-query"
              className="field field-sm"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder='e.g. "coffee stop", "cozy small lunch place"'
            />
          </label>
          <p
            className="text-xs text-neutral-500 dark:text-neutral-400"
            data-testid="corridor-search-scope-hint"
          >
            {backbone && backbone.length >= 2
              ? 'Searches along your route corridor, not just this map view. Finds land as pins for you to review, not added right away.'
              : 'Searches near this map view — pan/zoom to the area first. Finds land as pins on the map for you to review, not added right away.'}
          </p>

          {searchStatus && (
            <p
              data-testid="corridor-search-status"
              className="text-sm text-neutral-600 dark:text-neutral-300"
            >
              {searchStatus}
            </p>
          )}
          {searchError && (
            <p
              data-testid="corridor-search-error"
              className="text-sm text-red-600 dark:text-red-400"
            >
              {searchError}
            </p>
          )}

          <div className="flex gap-2">
            <button
              type="button"
              data-testid="corridor-search-submit"
              disabled={searching}
              onClick={() => void search()}
              className="btn btn-sm btn-primary"
            >
              {searching ? 'Searching…' : 'Search nearby'}
            </button>
            <button
              type="button"
              data-testid="corridor-search-done"
              onClick={() => {
                reset()
                setOpen(false)
              }}
              className="btn btn-sm btn-secondary"
            >
              Done
            </button>
          </div>
        </>
      )}
    </div>
  )
}
