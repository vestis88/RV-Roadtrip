import { httpsCallable } from 'firebase/functions'
import type { DaySection, Meal, TripDay } from '@rv/shared'
import { functions } from './firebase'
import { LONG_CALLABLE_TIMEOUT_MS } from './callableTimeouts'

/**
 * Past this without a heartbeat, a day still marked 'generating' is treated
 * as abandoned rather than slow.
 *
 * The callable refreshes detailStatusUpdatedAt every 20s for as long as its
 * container is alive, so silence for this long means the run is over however
 * it ended. Measured against the heartbeat and not against the start, which
 * is the distinction that let a stuck rescan sit behind a counter climbing
 * past ten minutes.
 */
const STALE_HEARTBEAT_MS = 75_000

/**
 * Asks the server to work out this day's activities and restaurants, and as
 * many days after it as the trip's "Plan ahead" setting says — see
 * functions/src/detailDaysCallable.ts. No count is sent, deliberately: the
 * server reads the setting off the trip, so this window and the one
 * generation fills in up front cannot drift apart.
 */
export async function detailDaysFrom(
  tripId: string,
  fromDayId: string,
): Promise<{ detailed: number; alreadyReady: number }> {
  const call = httpsCallable<
    { tripId: string; fromDayId: string },
    { detailed: number; alreadyReady: number }
  >(functions, 'detailDays', { timeout: LONG_CALLABLE_TIMEOUT_MS })
  const result = await call({ tripId, fromDayId })
  return result.data
}

/**
 * Fills one section of one day — the activities, or one meal's restaurants.
 *
 * Requested 2026-08-25: "the content could be generated for it with a click
 * on that empty header (lunch) for instance." See
 * functions/src/detailDaySectionCallable.ts for why this cannot just be a
 * smaller detailDays: it must not mark the day 'ready', or the day list
 * stops being derived from the locked stops the moment you fill one meal.
 */
export async function fillDaySection(
  tripId: string,
  dayId: string,
  kind: 'activity' | 'restaurant',
  meal?: Meal,
): Promise<{ section: DaySection; written: number }> {
  const call = httpsCallable<
    { tripId: string; dayId: string; kind: string; meal?: Meal },
    { section: DaySection; written: number }
  >(functions, 'detailDaySection', { timeout: LONG_CALLABLE_TIMEOUT_MS })
  const result = await call({ tripId, dayId, kind, ...(meal ? { meal } : {}) })
  return result.data
}

/**
 * What a day is doing about its own detail, as the screen needs to know it.
 *
 * `absent` is deliberately 'ready': every day written before the split
 * carries its detail already, and a trip planned last week must not come
 * back looking like it lost half of itself.
 */
export type DayDetailState = 'ready' | 'pending' | 'working' | 'stalled'

export function dayDetailState(
  day: Pick<TripDay, 'detailStatus' | 'detailStatusUpdatedAt'>,
  now: number,
): DayDetailState {
  const status = day.detailStatus ?? 'ready'
  if (status === 'ready') return 'ready'
  if (status === 'pending') return 'pending'
  const beat = day.detailStatusUpdatedAt
    ? new Date(day.detailStatusUpdatedAt).getTime()
    : Number.NaN
  // No heartbeat at all means a run started by an older deploy. Trusted
  // rather than declared dead — being wrong here costs a second paid call.
  if (!Number.isFinite(beat)) return 'working'
  return now - beat > STALE_HEARTBEAT_MS ? 'stalled' : 'working'
}

/**
 * What a single section of a day is doing, read off the DAY rather than
 * remembered by the screen.
 *
 * Reported 2026-09-01: *"Searched for dinner stops inside today. Closed app,
 * expecting results when I came back. Still nothing. No status."*
 *
 * There was nothing to come back to. The fill wrote its results at the end
 * and nothing before, so a request in flight existed only as a promise held
 * by one component, and its failure only as a string in that component's
 * state — both destroyed by closing the tab. The trip is where a request
 * that outlives its connection has to leave its account of itself; the
 * rescan learned this on 2026-08-16 and this path never did.
 */
export type SectionFill =
  | { kind: 'idle' }
  | { kind: 'working'; startedAt: string }
  | { kind: 'stalled'; startedAt: string }
  | { kind: 'failed'; message: string }

/**
 * How long a section fill may run before it is presumed dead.
 *
 * Generous: the Claude turn plus per-place verification is tens of seconds,
 * and a container killed mid-run leaves `sectionStatus` behind with nobody
 * to clear it. Being wrong in the impatient direction costs a second paid
 * call, so this waits.
 */
const SECTION_STALE_MS = 5 * 60_000

export function sectionFill(
  day: Pick<TripDay, 'sectionStatus' | 'sectionLastError'>,
  section: DaySection,
  now: number,
): SectionFill {
  const running = day.sectionStatus
  if (running?.section === section) {
    const started = new Date(running.startedAt).getTime()
    // An unreadable timestamp is trusted rather than declared dead, for the
    // same reason dayDetailState trusts a missing heartbeat.
    if (!Number.isFinite(started) || now - started <= SECTION_STALE_MS) {
      return { kind: 'working', startedAt: running.startedAt }
    }
    return { kind: 'stalled', startedAt: running.startedAt }
  }
  // A failure outranks nothing-happening, and only for the section it
  // belongs to: a dinner that failed says nothing about lunch.
  const failure = day.sectionLastError
  if (failure?.section === section) {
    return { kind: 'failed', message: failure.message }
  }
  return { kind: 'idle' }
}
