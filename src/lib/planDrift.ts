import { ROAD_DISTANCE_FACTOR, haversineDistanceKm } from '@rv/shared'
import type { LatLng } from '@rv/shared'

/**
 * The drift check, in the terms a traveler actually thinks in.
 *
 * It used to be one line: straight-line distance from here to TONIGHT'S
 * overnight town, prompt above 50 km. That is a proxy for being behind, and
 * a poor one in three separate ways:
 *
 * - It has no sign. Parking 60 km PAST tonight's town — comfortably ahead —
 *   measured exactly the same as stopping 60 km short of it, so a good day
 *   was as likely to raise the banner as a bad one.
 * - It has no units a person uses. Nobody plans in kilometres-from-a-town;
 *   they think "we're about a day behind". 60 km on a slow, sight-heavy
 *   stretch can BE a day, while 180 km on a transit day is an afternoon.
 * - It is blind to the shape of the trip. One fixed threshold is applied to
 *   a 200 km week and a 4,000 km month alike.
 *
 * So this measures PROGRESS ALONG the planned route instead: how far through
 * the trip the traveler has actually got, against how far the plan says they
 * should be by tonight, converted into days using the pace of the days that
 * are left. Everything here is straight-line and multiplied by
 * ROAD_DISTANCE_FACTOR — an estimate, deliberately, since this decides
 * whether to ASK a question, not what to do about it. The replan itself
 * measures properly.
 */

/** One night of the plan, in the only terms this needs. */
export interface PlannedNight {
  date: string
  overnight: LatLng
}

export interface PlanDrift {
  /**
   * Route kilometres between where the traveler is and where tonight's stop
   * is. Negative when they are ahead of the plan.
   */
  behindKm: number
  /**
   * The same gap in days, at the pace the REMAINING days are planned at.
   * Null when the remaining pace cannot be worked out (the last night, or a
   * plan whose nights do not move) — a gap in kilometres is still real then,
   * it simply cannot be expressed in days.
   */
  behindDays: number | null
}

/**
 * Distance along a polyline to the point on it closest to `here`.
 *
 * Projection onto each segment rather than distance to the nearest vertex,
 * so a traveler halfway between two overnight towns reads as halfway rather
 * than as "at whichever town is nearer". Uses a local flat-earth
 * approximation, which at the scale of one leg of a road trip is far below
 * the error already accepted by using straight lines at all.
 */
function progressAlongKm(route: LatLng[], here: LatLng): number {
  if (route.length === 0) return 0
  if (route.length === 1) return 0

  let travelled = 0
  let bestProgress = 0
  let bestDistance = Infinity

  for (let i = 0; i < route.length - 1; i++) {
    const a = route[i]
    const b = route[i + 1]
    const legKm = haversineDistanceKm(a, b)
    // Degrees are not a distance, but within one leg the ratio is all that
    // is used, so a consistent local scaling is enough.
    const scale = Math.cos((a.lat * Math.PI) / 180) || 1
    const ax = a.lng * scale
    const ay = a.lat
    const bx = b.lng * scale
    const by = b.lat
    const hx = here.lng * scale
    const hy = here.lat
    const dx = bx - ax
    const dy = by - ay
    const lengthSq = dx * dx + dy * dy
    const t =
      lengthSq === 0
        ? 0
        : Math.max(0, Math.min(1, ((hx - ax) * dx + (hy - ay) * dy) / lengthSq))
    const closest = { lat: ay + t * dy, lng: (ax + t * dx) / scale }
    const distance = haversineDistanceKm(here, closest)
    if (distance < bestDistance) {
      bestDistance = distance
      bestProgress = travelled + t * legKm
    }
    travelled += legKm
  }

  return bestProgress
}

/** Cumulative straight-line distance to each point of a route. */
function cumulative(route: LatLng[]): number[] {
  const out: number[] = [0]
  for (let i = 1; i < route.length; i++) {
    out.push(out[i - 1] + haversineDistanceKm(route[i - 1], route[i]))
  }
  return out
}

/**
 * How far behind (or ahead of) the plan the traveler is, right now.
 *
 * `nights` must be the whole trip in date order, and `start` the point the
 * trip began from — the first night is a destination, not an origin, so
 * without it the first day's progress has nothing to measure from.
 * Returns null when there is nothing to compare against: no plan, or a today
 * that is not one of its days.
 */
export function planDrift(input: {
  start: LatLng
  nights: PlannedNight[]
  today: string
  here: LatLng
}): PlanDrift | null {
  const { start, nights, today, here } = input
  const todayIndex = nights.findIndex((night) => night.date === today)
  if (todayIndex === -1) return null

  const route = [start, ...nights.map((night) => night.overnight)]
  const marks = cumulative(route)
  // Where the plan says tonight ends. +1 because `route` is offset by the
  // start point.
  const expected = marks[todayIndex + 1]
  const actual = progressAlongKm(route, here)
  const behindKm = (expected - actual) * ROAD_DISTANCE_FACTOR

  // The pace of what is LEFT, not of what has been done — catching up
  // happens across the remaining days, so those are the days the gap has to
  // be expressed in. Measured from tonight to the end of the trip.
  const remainingNights = nights.length - 1 - todayIndex
  const remainingKm =
    (marks[marks.length - 1] - expected) * ROAD_DISTANCE_FACTOR
  const perDay = remainingNights > 0 ? remainingKm / remainingNights : 0
  const behindDays = perDay > 0 ? behindKm / perDay : null

  return { behindKm, behindDays }
}

/**
 * Whether that gap is worth interrupting the traveler about.
 *
 * Two gates, and a drift has to clear BOTH: far enough to matter in absolute
 * terms, and far enough to matter relative to how the rest of the trip is
 * paced. A trip whose remaining days average 400 km can absorb 60 km without
 * anyone needing to know; a trip averaging 80 km cannot. Being ahead of the
 * plan never prompts, which the old distance-only check could not express at
 * all.
 */
export const BEHIND_PLAN_THRESHOLD_KM = 50
export const BEHIND_PLAN_THRESHOLD_DAYS = 0.4

export function shouldPromptReplan(drift: PlanDrift | null): boolean {
  if (!drift) return false
  if (drift.behindKm <= BEHIND_PLAN_THRESHOLD_KM) return false
  // No usable pace (the final night) — fall back to the absolute gap alone
  // rather than staying silent about a traveler who is a long way short of
  // where the trip ends.
  if (drift.behindDays === null) return true
  return drift.behindDays >= BEHIND_PLAN_THRESHOLD_DAYS
}

/**
 * What the banner says. Days first, because that is the unit the decision is
 * actually made in; the kilometres are the evidence for it.
 */
export function describePlanDrift(drift: PlanDrift): string {
  const km = Math.round(drift.behindKm)
  if (drift.behindDays === null) return `You're ${km} km short of tonight's stop.`
  const days = drift.behindDays
  const inDays =
    days >= 0.75 && days < 1.25
      ? 'about a day behind'
      : days >= 1.25
        ? `about ${Math.round(days)} days behind`
        : 'about half a day behind'
  return `You're ${inDays} — roughly ${km} km short of tonight's stop.`
}
