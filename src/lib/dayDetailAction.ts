import { httpsCallable } from 'firebase/functions'
import type { TripDay } from '@rv/shared'
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
