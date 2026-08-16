import { doc, updateDoc } from 'firebase/firestore'
import { httpsCallable } from 'firebase/functions'
import { sortAlongRoute } from '@rv/shared'
import type { CorridorStopPriority, LatLng } from '@rv/shared'
import { db, functions } from './firebase'
import type { CorridorStopWithId } from '../hooks/useCorridorStops'
import { LONG_CALLABLE_TIMEOUT_MS } from './callableTimeouts'

/**
 * Most-interested first. No longer the order the list renders in — that is
 * route order now (see sortAlongRoute) — but still the order the interest
 * selector lays its options out, and still the order the generation reads
 * them in when deciding what to fit.
 */
export const TIER_ORDER: CorridorStopPriority[] = [
  'must-see',
  'worth-a-detour',
  'nice-if-convenient',
]

/** What each interest level is called on the card's selector. */
export const TIER_LABEL: Record<CorridorStopPriority, string> = {
  'must-see': 'Must see',
  'worth-a-detour': 'Worth a detour',
  'nice-if-convenient': 'If convenient',
}

/**
 * Set a candidate's interest level directly (2026-08-12).
 *
 * Replaces a pair of up/down arrows that moved the stop one category per
 * tap. Those made sense while the list was grouped by category and sorted by
 * it: the arrows were how you moved a card between headings. The list is
 * ordered by route position now, so a vote no longer moves the card at all
 * — it only repaints it — and an arrow that changes a value you cannot see
 * is a worse control than a switch showing the value.
 *
 * `rank` is deliberately not written any more. It only ever ordered stops
 * within a category, and nothing reads that: the list sorts geographically
 * and the generation groups by tier.
 *
 * A plain client Firestore write, same as every other corridor-stop action
 * (src/lib/corridorStopActions.ts) — firestore.rules already allows any
 * member to write corridorStops.
 */
export async function setCandidatePriority(
  tripId: string,
  stopId: string,
  priority: CorridorStopPriority,
): Promise<void> {
  await updateDoc(doc(db, 'trips', tripId, 'corridorStops', stopId), {
    priority,
  })
}

/**
 * The interest level a candidate is currently at. Claude sets one on every
 * stop it proposes, and that pre-selection is kept — this only fills in the
 * gap for a stop that has none (a pin the traveler dropped themselves).
 */
export function candidatePriority(
  candidate: CorridorStopWithId,
): CorridorStopPriority {
  return candidate.priority ?? 'worth-a-detour'
}

/**
 * The explore list in the order you would drive past the stops (2026-08-12).
 *
 * The list used to be three sections, one per interest level. That answered
 * "which of these does the app think are best", which the traveler already
 * knows from the card, and made the question they actually had — where does
 * this sit relative to the others, is it before or after Hamburg — one they
 * had to reconstruct by cross-referencing three lists against the map.
 * Interest level is now a property of a card rather than a place in the
 * list.
 */
export function sortCandidatesForList(
  candidates: CorridorStopWithId[],
  startPoint: LatLng | undefined,
  endPoint: LatLng | undefined,
): CorridorStopWithId[] {
  return sortAlongRoute(startPoint, endPoint, candidates, (candidate) => ({
    lat: candidate.lat,
    lng: candidate.lng,
  }))
}

export const GENERIC_STOPS_ERROR = 'Could not find stops right now — please try again.'

// Codes generateExploreHighlights raises itself, every one of them with a
// message written for the traveler. Everything else a callable can fail
// with — 'deadline-exceeded', 'unavailable', 'cancelled' — carries the code
// string as its message, which is not something to put on screen.
/**
 * What a search that ran out of time should say.
 *
 * 'deadline-exceeded' is the one failure a traveler can act on, and the
 * generic "please try again" is the worst possible advice for it: re-running
 * the identical search is the one thing certain to take just as long. The
 * levers that actually help are a smaller area or a specific description,
 * so the message names them.
 */
const SEARCH_TIMEOUT_MESSAGE =
  'That search took too long to finish. Try a smaller area, or describe what ' +
  'you are looking for so the search has less ground to cover.'

const SERVER_AUTHORED_CODES = new Set([
  'functions/failed-precondition',
  'functions/internal',
  'functions/invalid-argument',
  'functions/not-found',
  'functions/permission-denied',
  'functions/unauthenticated',
])

/**
 * Prefers the server's own account of what went wrong (2026-08-12).
 *
 * Both callers used to replace every failure with one generic "please try
 * again", which is wrong twice over. It threw away messages written
 * specifically for this moment — "Already finding great stops for this trip
 * — hang tight" is a request to WAIT, and re-pressing is the one thing that
 * cannot help — and it advised a retry for faults that are deterministic,
 * so a traveler hitting one pressed the button until they gave up, paying
 * for two Claude calls a press. See exploreHighlightsCallable.ts, which now
 * makes sure an unexpected server failure carries a real message too.
 *
 * 'INTERNAL' is firebase-functions' placeholder for a server error it could
 * not describe, and a network failure's "Failed to fetch" says nothing a
 * traveler can act on — both fall back to the generic line.
 */
export function describeExploreHighlightsError(error: unknown): string {
  const { code, message } = (error ?? {}) as { code?: unknown; message?: unknown }
  if (code === 'functions/deadline-exceeded') return SEARCH_TIMEOUT_MESSAGE
  if (typeof code !== 'string' || !SERVER_AUTHORED_CODES.has(code)) {
    return GENERIC_STOPS_ERROR
  }
  // A message that is just the code repeated back says nothing a traveler
  // can use — and it reached the screen anyway, as the single word
  // "internal", because this only rejected the exact uppercase spelling.
  // The Firebase client emits either casing depending on the path, so the
  // comparison is case-insensitive and covers the code itself, not one
  // spelling of it.
  const named = typeof message === 'string' ? message.trim() : ''
  const codeWord = code.replace(/^functions\//, '')
  if (
    named === '' ||
    named.toLowerCase() === codeWord.toLowerCase() ||
    named.toLowerCase() === code.toLowerCase()
  ) {
    return GENERIC_STOPS_ERROR
  }
  return named
}

/**
 * Triggers the cheap, repeatable highlights-only curation pass. The result
 * is merged into the corridor, so `candidateCount` is what was ADDED and
 * `alreadyKnown` is how much of the answer was already on the list — an
 * older deployment returns only the former, hence the fallback.
 */
export interface EmptyCountry {
  country: string
  reason: 'not-proposed' | 'not-located'
  proposed: number
  note?: string
}

export async function generateExploreHighlights(
  tripId: string,
): Promise<{
  candidateCount: number
  alreadyKnown: number
  emptyCountries: EmptyCountry[]
}> {
  const call = httpsCallable<
    { tripId: string },
    {
      candidateCount: number
      alreadyKnown?: number
      emptyCountries?: EmptyCountry[]
    }
  >(functions, 'generateExploreHighlights', { timeout: LONG_CALLABLE_TIMEOUT_MS })
  const result = await call({ tripId })
  return {
    candidateCount: result.data.candidateCount,
    alreadyKnown: result.data.alreadyKnown ?? 0,
    emptyCountries: result.data.emptyCountries ?? [],
  }
}

/**
 * What to say about countries the traveler chose that came back empty.
 *
 * They used to be said nothing about at all: a country picked in Trip Setup
 * could simply not appear in the answer, and no screen anywhere mentioned
 * it. Naming the country and which kind of empty it was is the whole point —
 * "nothing was proposed there" and "things were proposed and none could be
 * found on the map" are different problems.
 */
export function describeEmptyCountries(
  empty: EmptyCountry[],
  nameOf: (code: string) => string,
): string | null {
  if (empty.length === 0) return null
  return empty
    .map((entry) => {
      const name = nameOf(entry.country)
      if (entry.reason === 'not-located') {
        const n = entry.proposed
        return n === 1
          ? `${name}: 1 suggestion came back but it could not be found on the map.`
          : `${name}: ${n} suggestions came back but none of them could be found on the map.`
      }
      return entry.note
        ? `${name}: nothing suggested — ${entry.note}`
        : `${name}: nothing suggested for this trip.`
    })
    .join(' ')
}
