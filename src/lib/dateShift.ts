import { doc, writeBatch } from 'firebase/firestore'
import type { PlanMeta, TripSettings } from '@rv/shared'
import { db } from './firebase'

/** The settings a shift can answer completely, and nothing else. */
const DATE_SETTINGS = new Set(['startDate', 'endDate'])

/** Adds `n` calendar days to a YYYY-MM-DD string, in UTC. */
export function addDays(date: string, n: number): string {
  const next = new Date(
    new Date(`${date}T00:00:00Z`).getTime() + n * 86_400_000,
  )
  return next.toISOString().slice(0, 10)
}

function daysBetween(from: string, to: string): number {
  return Math.round(
    (new Date(`${to}T00:00:00Z`).getTime() -
      new Date(`${from}T00:00:00Z`).getTime()) /
      86_400_000,
  )
}

/**
 * The cheapest correct answer to "we're leaving a week later".
 *
 * Moving a trip without changing its length changes nothing about the plan
 * except every day's date. The route is the same, the towns are the same, in
 * the same order, and the activities and restaurants chosen for them are
 * still the right ones. It is arithmetic.
 *
 * It was, until now, the most expensive thing you could do: a date edit
 * marked the plan stale, and the only way out was "Rebuild plan" — a full
 * regeneration that deletes every day and takes the traveler's per-day
 * choices with it. Reported as "I'm trying to find ways to not accidentally
 * lose already researched data", and then "how to just change dates of the
 * trip then?".
 *
 * Deliberately NOT offered when the trip's LENGTH changed. Adding or
 * removing days is a real planning problem — where does the extra night go,
 * what gets cut — and re-dating cannot answer it.
 */
export interface DateShift {
  /** Days to add to every day of the plan. Negative moves the trip earlier. */
  offsetDays: number
  /** The plan's current first day, for the label. */
  from: string
  /** Where it would move to. */
  to: string
}

export function detectDateShift(input: {
  settings: Pick<TripSettings, 'startDate' | 'endDate'>
  planMeta: PlanMeta
  /** Every day of the plan, in date order. */
  dayDates: string[]
}): DateShift | null {
  const { settings, planMeta, dayDates } = input
  if (planMeta.status !== 'stale' || dayDates.length === 0) return null

  // Only when dates are the WHOLE reason the plan is stale. A trip that also
  // changed its drive-hours ceiling has a problem no amount of re-dating
  // answers, and quietly marking it ready again would bury that.
  //
  // An older plan carries no record of why it went stale (the field is newer
  // than it), and a missing reason is not the same as "only the dates" — so
  // it is not offered, and the traveler is no worse off than before.
  const reasons = planMeta.staleSettings
  if (!reasons || reasons.length === 0) return null
  if (!reasons.every((key) => DATE_SETTINGS.has(key))) return null

  const planStart = dayDates[0]
  const planEnd = dayDates[dayDates.length - 1]
  // The plan's own span against the trip's. Equal spans and a moved start is
  // exactly a shift; anything else is a length change.
  if (
    daysBetween(planStart, planEnd) !==
    daysBetween(settings.startDate, settings.endDate)
  ) {
    return null
  }
  const offsetDays = daysBetween(planStart, settings.startDate)
  if (offsetDays === 0) return null

  return { offsetDays, from: planStart, to: settings.startDate }
}

/** What the button says. */
export function describeDateShift(shift: DateShift): string {
  const n = Math.abs(shift.offsetDays)
  const unit = n === 1 ? 'day' : 'days'
  return shift.offsetDays > 0
    ? `Move the plan ${n} ${unit} later`
    : `Move the plan ${n} ${unit} earlier`
}

/**
 * Re-dates every day and puts the plan back to `ready`.
 *
 * One batch, so a plan can never end up half-shifted — days with two
 * different offsets would be a worse state than the one being fixed. No
 * Claude call, no Places call: nothing about the days is re-decided, only
 * `date` is rewritten.
 */
export async function shiftPlanDates(
  tripId: string,
  days: { id: string; date: string }[],
  offsetDays: number,
): Promise<void> {
  const batch = writeBatch(db)
  for (const day of days) {
    batch.update(doc(db, 'trips', tripId, 'days', day.id), {
      date: addDays(day.date, offsetDays),
    })
  }
  batch.update(doc(db, 'trips', tripId), {
    'planMeta.status': 'ready',
    'planMeta.staleSettings': [],
  })
  await batch.commit()
}
