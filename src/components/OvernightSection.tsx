import { useState } from 'react'
import { httpsCallable } from 'firebase/functions'
import type { OvernightStopCandidate, TripDay } from '@rv/shared'
import { functions } from '../lib/firebase'
import { LONG_CALLABLE_TIMEOUT_MS } from '../lib/callableTimeouts'
import { chooseOvernight } from '../lib/chooseOvernight'
import { CardRow } from './CardRow'
import { PlaceCard } from './PlaceCard'
import type { OvernightOptionWithId } from '../hooks/useDayDetail'

/**
 * Where this day could sleep — an ordinary section of the day, exactly like
 * Activities, Breakfast, Lunch and Dinner.
 *
 * Requested 2026-09-02: *"I want the overnight stop options to show on the
 * map in a similar way as activities and restaurants"*, and then, on being
 * shown a bespoke panel wired to the map with its own open state and its own
 * highlighting: *"I want the exact same kind of logic as the list for the
 * restaurants and activities. There is no need for different functionality,
 * or is there?"*
 *
 * There is not, and the previous shape was a leftover from when choosing a
 * bed meant submitting a replan: a collapsible panel, opened by a link,
 * holding a list nothing else on the screen could reach. It became a section
 * because every part of it already had a counterpart —
 *
 *  - the row, the cards and the horizontal scroller are the same components;
 *  - an empty row offers to fill itself, the same as "Find things to do";
 *  - tapping a card selects it and pans the map, the same as an activity;
 *  - and a pin on the map selects the card, by the same `selectedPlace`.
 *
 * **The one real difference, since it was asked directly:** an overnight is a
 * single choice that lands on the day, where an activity or a restaurant
 * each carries its own status and several can be selected at once. So a card
 * here reads as chosen rather than as selected-among-many, and choosing one
 * un-chooses the last. That is a fact about sleeping in one place at a time,
 * not a reason for different machinery.
 */
export function OvernightSection({
  tripId,
  dayId,
  day,
  options,
  selectedPlaceId,
  onSelect,
  planBusy,
}: {
  tripId: string
  dayId: string
  day: TripDay
  options: OvernightOptionWithId[]
  selectedPlaceId: string | undefined
  onSelect: (
    cardId: string,
    place: { name: string; lat: number; lng: number },
  ) => void
  /**
   * A full generation owns the days while it runs and would overwrite a
   * choice made underneath it — the same guard every other writer here has.
   */
  planBusy: boolean
}) {
  const [finding, setFinding] = useState(false)
  /**
   * A look that has happened and come back with nothing, which is not the
   * same as not having looked. The old panel said so and the row keeps it:
   * every source can be unreachable at once, and "nothing nearby" is then
   * the honest answer rather than an error.
   */
  const [lookedAndFoundNothing, setLookedAndFoundNothing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [choosing, setChoosing] = useState<string | null>(null)

  /** The same shape as a section's "Find things to do" — see CardRow.empty. */
  async function find() {
    setFinding(true)
    setError(null)
    try {
      const call = httpsCallable<
        { tripId: string; dayId: string },
        { candidates: OvernightStopCandidate[] }
      >(functions, 'getOvernightCandidates', {
        timeout: LONG_CALLABLE_TIMEOUT_MS,
      })
      // The callable writes them to the day's own `overnightOptions`, which
      // useDayDetail streams — so nothing is returned into state here and
      // the results survive the app closing, like every other lookup.
      const result = await call({ tripId, dayId })
      setLookedAndFoundNothing(result.data.candidates.length === 0)
    } catch (err) {
      console.error('getOvernightCandidates failed', err)
      setError('Could not look for places to sleep — please try again.')
    } finally {
      setFinding(false)
    }
  }

  async function choose(option: OvernightOptionWithId) {
    setChoosing(option.id)
    setError(null)
    try {
      await chooseOvernight(tripId, dayId, day, option)
    } catch (err) {
      console.error('Saving the overnight choice failed', err)
      setError('Could not save that — please try again.')
    } finally {
      setChoosing(null)
    }
  }

  const wild = options.some((option) => option.type === 'wild')

  return (
    <CardRow
      title="Where to sleep"
      testId="overnight-row"
      empty={
        options.length === 0 ? (
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              data-testid="overnight-row-fill"
              className="btn btn-sm btn-secondary disabled:opacity-40"
              disabled={finding || planBusy}
              onClick={() => void find()}
            >
              {finding ? 'Looking…' : 'Find where to sleep'}
            </button>
            {lookedAndFoundNothing && !finding && (
              <span
                data-testid="overnight-row-empty"
                className="text-xs text-neutral-500 dark:text-neutral-400"
              >
                Nothing found nearby.
              </span>
            )}
            {error && (
              <span
                data-testid="overnight-row-error"
                className="text-xs text-red-600 dark:text-red-400"
              >
                {error}
              </span>
            )}
          </div>
        ) : undefined
      }
      footer={
        /* Kept from the old panel because it is a safety note rather than a
         * piece of that panel: legality varies by country and the app is
         * suggesting somewhere to park overnight. */
        wild ? (
          <span
            data-testid="wild-camping-caveat"
            className="text-xs text-amber-800 dark:text-amber-200"
          >
            Wild camping legality varies a lot by country and region — verify
            locally before relying on any of these.
          </span>
        ) : error ? (
          <span
            data-testid="overnight-row-error"
            className="text-xs text-red-600 dark:text-red-400"
          >
            {error}
          </span>
        ) : undefined
      }
    >
      {options.map((option) => {
        const cardId = `overnight-option-${option.id}`
        const chosen = option.name === day.overnight.name
        return (
          <PlaceCard
            key={option.id}
            testId={cardId}
            name={option.name}
            category={option.type}
            blurb={
              option.source === 'claude'
                ? `${option.description} AI-suggested — verify locally.`
                : option.description
            }
            googleMapsUrl={option.googleMapsUrl}
            selected={selectedPlaceId === cardId}
            // One bed a night: the chosen one reads as chosen, and choosing
            // another un-chooses it. See the note at the top of this file.
            status={chosen ? 'selected' : 'suggested'}
            busy={choosing !== null || planBusy}
            onTap={() =>
              onSelect(cardId, {
                name: option.name,
                lat: option.lat,
                lng: option.lng,
              })
            }
            onToggleSelected={chosen ? undefined : () => void choose(option)}
          />
        )
      })}
    </CardRow>
  )
}

export default OvernightSection
