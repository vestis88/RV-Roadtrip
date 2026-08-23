import { doc, updateDoc } from 'firebase/firestore'
import { httpsCallable } from 'firebase/functions'
import { sortAlongRoute } from '@rv/shared'
import type {
  CorridorStop,
  CorridorStopPriority,
  EmptyCountry,
  LatLng,
  Trip,
} from '@rv/shared'
import { db, functions } from './firebase'
import { isDeadlineExceeded, serverAuthoredMessage } from './callableError'
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
 * How long the traveler intends to stay at a stop (2026-08-23).
 *
 * Written straight to the stop, like the interest level above and for the
 * same reason: it is the traveler's own judgement about a place, not
 * something any generation should overwrite. The board's day budget reads
 * it back (see tripBudget) and the number moves the moment this lands.
 */
export async function setStopStay(
  tripId: string,
  stopId: string,
  stayDuration: CorridorStop['stayDuration'],
): Promise<void> {
  await updateDoc(doc(db, 'trips', tripId, 'corridorStops', stopId), {
    stayDuration,
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
  if (isDeadlineExceeded(error)) return SEARCH_TIMEOUT_MESSAGE
  // The code/message rules moved to callableError.ts once a third screen
  // needed them; the fallback line stays here because it is this search's.
  return serverAuthoredMessage(error) ?? GENERIC_STOPS_ERROR
}

/**
 * What to say when the server never answered this phone.
 *
 * Holding a callable open for three minutes from a phone does not reliably
 * work — a locked screen, a tab switch or a cellular NAT timeout drops the
 * request — and the function keeps running regardless, because the client
 * hanging up does not cancel it. Telling the traveler to "try again" then
 * asks them to pay for a second Claude call on top of one that is still
 * working. RescanCorridorButton has drawn this distinction since 2026-08-16.
 */
const STILL_RUNNING_MESSAGE =
  'Still searching — this phone stopped following it, but the search is ' +
  'running on the server. Its finds appear on their own; you can leave ' +
  'this screen.'

/** And when that search turns out to have worked after all. */
const FINISHED_WITHOUT_US_MESSAGE =
  'That search finished on the server after this phone lost the connection — ' +
  'anything it found is already on the map.'

export interface ExploreFailureNotice {
  /** 'info' means nothing has gone wrong — the search is alive, or done. */
  tone: 'info' | 'error'
  message: string
}

/**
 * What the trip already said before this attempt, so its own outcome can be
 * told apart from one left over from last week.
 *
 * Deliberately a before/after comparison rather than "is the server's
 * timestamp later than when I pressed the button": those two clocks are a
 * phone's and a datacentre's, and a phone a minute fast would discount a
 * result that had genuinely just arrived.
 */
export interface ExploreAttemptBaseline {
  lastRunAt?: string
  lastFailedAt?: string
}

export function exploreAttemptBaseline(
  planMeta: Trip['planMeta'],
): ExploreAttemptBaseline {
  return {
    lastRunAt: planMeta.exploreLastRunAt,
    lastFailedAt: planMeta.exploreLastFailedAt,
  }
}

/**
 * What to say when the call rejected without the server having said anything
 * (2026-08-17).
 *
 * `before` is the trip as it stood when this attempt was fired, and null when
 * there is nothing to report. Being here at all means
 * describeExploreHighlightsError found no real cause in the rejection — no
 * server-authored code, or the bare word "internal" — which is what a dropped
 * connection and a container that died without answering both look like from
 * the phone. Neither is something the traveler did, and neither is grounds
 * for the flat "please try again" that was being shown: reported as exactly
 * that line, on a trip already back at idle, with no record anywhere of what
 * had gone wrong.
 *
 * So the trip decides rather than the socket, and only what changed since
 * `before` counts. It is still running: say so. It finished: say that,
 * because a search that succeeded unwatched is the likeliest outcome of a
 * phone locking mid-call, and "please try again" would charge for it twice.
 * It failed and the server recorded why (planMeta.exploreLastError, written
 * where it outlives the request): say what broke.
 *
 * Read live during render, deliberately, rather than resolved once in the
 * catch — every one of those signals arrives after the promise rejects.
 */
export function exploreFailureMessage(
  before: ExploreAttemptBaseline | null,
  planMeta: Trip['planMeta'],
): ExploreFailureNotice | null {
  if (!before) return null
  if (planMeta.exploreStatus === 'generating') {
    return { tone: 'info', message: STILL_RUNNING_MESSAGE }
  }
  const failedAt =
    planMeta.exploreLastFailedAt !== before.lastFailedAt
      ? planMeta.exploreLastFailedAt
      : undefined
  const ranAt =
    planMeta.exploreLastRunAt !== before.lastRunAt
      ? planMeta.exploreLastRunAt
      : undefined
  if (ranAt && (!failedAt || ranAt > failedAt)) {
    return { tone: 'info', message: FINISHED_WITHOUT_US_MESSAGE }
  }
  // Shown as stored: the callable writes the same sentence it rejects with,
  // so this is the message that connection would have carried.
  if (failedAt && planMeta.exploreLastError) {
    return { tone: 'error', message: planMeta.exploreLastError }
  }
  return { tone: 'error', message: GENERIC_STOPS_ERROR }
}

/**
 * Triggers the cheap, repeatable highlights-only curation pass. The result
 * is merged into the corridor, so `candidateCount` is what was ADDED and
 * `alreadyKnown` is how much of the answer was already on the list — an
 * older deployment returns only the former, hence the fallback.
 */
/**
 * Re-exported from the shared schema, which is where this shape lives now
 * that it is written onto the trip as well as returned from the callable.
 */
export type { EmptyCountry }

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

/** Never searched. */
const NEVER_SEARCHED_MESSAGE =
  'No stops yet — tap "Find great stops" to get suggestions for your route, ' +
  'or drop a pin / rescan an area on the map above.'

/** Searched, and the answer really was nothing. */
const SEARCHED_AND_EMPTY_MESSAGE =
  'Nothing stood out along this route — for a short or local trip, that can ' +
  'be the honest answer. Try "Rescan this area," describe what you\'re ' +
  'looking for with "Add stop," or drop a pin yourself.'

/** Searched, nothing found, and the trip knows something about why. */
const SEARCHED_AND_EMPTY_WITH_REASON =
  'The last search came back with nothing to add.'

const CHECK_COUNTRIES_HINT =
  'If that looks wrong, check the countries picked in Trip Setup — a new ' +
  'trip carries the previous one\'s country list over but not its route, so ' +
  'the list can end up naming nowhere this trip actually goes.'

/**
 * What an empty candidate list should say (2026-08-17).
 *
 * Three different situations used to produce two sentences between them, and
 * the wrong one at the worst moment: a Copenhagen–München trip that returned
 * nothing was told "for a short or local trip, that can be the honest
 * answer". It is 1,300 km. The reason the answer was empty had been worked
 * out server-side, handed back through the callable, and then dropped,
 * because the search had been fired from Trip Setup and Trip Setup navigates
 * here on success — so the screen holding the explanation unmounted before
 * it could show it. planMeta.exploreLastEmptyCountries is that explanation,
 * kept on the trip where the screen that has to say it can read it.
 */
export function describeEmptyCandidateList(
  planMeta: Trip['planMeta'],
  nameOf: (code: string) => string,
): string {
  if (!planMeta.exploreLastRunAt) return NEVER_SEARCHED_MESSAGE
  const gaps = describeEmptyCountries(
    planMeta.exploreLastEmptyCountries ?? [],
    nameOf,
  )
  if (!gaps) return SEARCHED_AND_EMPTY_MESSAGE
  return `${SEARCHED_AND_EMPTY_WITH_REASON} ${gaps} ${CHECK_COUNTRIES_HINT}`
}
