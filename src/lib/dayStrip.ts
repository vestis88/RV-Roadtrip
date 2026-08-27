import type { TripDayWithId } from '../hooks/useTripDays'

/**
 * The day strip, anchored to now.
 *
 * Reported 2026-08-25: "The days on top are still som old irrelevant stuff. I
 * want info about today, tomorrow and so on."
 *
 * The strip listed every day of the trip from day one, which is the right
 * answer at a kitchen table three months out and the wrong one from a
 * driver's seat on day twelve: the first thing on screen was a town left a
 * week and a half ago. It starts at today now, and the days behind you are
 * still reachable — hidden, not deleted, because "where did we sleep on
 * Tuesday" is a real question.
 *
 * Before the trip starts there is no "today" inside it, so it stays exactly
 * as it was: Day 1, Day 2, and so on.
 */

export interface DayChip {
  day: TripDayWithId
  /** "Today", "Tomorrow", "Day 4", or a date — see labelFor. */
  label: string
}

export interface DayStrip {
  /** What to show, starting at today once the trip is under way. */
  upcoming: DayChip[]
  /** Days already behind, oldest first. Revealed on request. */
  past: DayChip[]
}

export function dayStrip(days: TripDayWithId[], today: string): DayStrip {
  const ordered = [...days].sort((a, b) => a.index - b.index)
  const started = ordered.some((day) => day.date <= today)
  const ends = ordered[ordered.length - 1]?.date

  // Wholly ahead, or wholly behind. A finished trip has no "today" in it
  // either, and relabelling its last day "Today" would be a lie — so both
  // ends fall back to the plain numbering.
  if (!started || (ends !== undefined && ends < today)) {
    return {
      upcoming: ordered.map((day) => ({ day, label: `Day ${day.index + 1}` })),
      past: [],
    }
  }

  const chips = ordered.map((day) => ({ day, label: labelFor(day, today) }))
  return {
    upcoming: chips.filter((chip) => chip.day.date >= today),
    past: chips.filter((chip) => chip.day.date < today),
  }
}

/**
 * "Today" and "Tomorrow" carry the two days anyone actually acts on; after
 * that a date is more use than a day number, because nobody counts to
 * seventeen to work out when they are somewhere.
 */
export function labelForDate(date: string, today: string): string {
  if (date === today) return 'Today'
  if (date === addDays(today, 1)) return 'Tomorrow'
  return formatShortDate(date)
}

function labelFor(day: TripDayWithId, today: string): string {
  return labelForDate(day.date, today)
}

/**
 * The strip built from the KEPT STOPS rather than from the stored days.
 *
 * Reported 2026-08-26, twice: "It shows Seiser Alm as previous even though we
 * haven't marked it done. Same with next locked in stop on the map,
 * Kronplatz, is also shown as earlier, even though it's clearly marked as
 * next on the map."
 *
 * Both were the same thing. The strip is a VIEW of the `days` collection, and
 * on this trip that collection is left over from an older generation — so it
 * dated Kronplatz to two days ago while the board, correctly, had it as the
 * next stop ahead. Relabelling the "Today" chip patched one entry and left
 * the rest saying the same wrong thing.
 *
 * So when the days no longer describe the kept stops, the strip stops
 * reading them and reads the board instead: the stops in the order they will
 * be driven, dated by their arrival estimates. Nothing is written — the
 * stored days still hold the researched detail, and rebuilding them stays
 * the traveler's choice.
 */
export interface DerivedChip<T> {
  stop: T
  label: string
}

export function derivedDayStrip<T extends { id: string }>(
  stops: T[],
  arrivals: Map<string, { date: string }>,
  today: string,
): DerivedChip<T>[] {
  return stops
    .map((stop) => {
      const date = arrivals.get(stop.id)?.date
      return date ? { stop, label: labelForDate(date, today) } : null
    })
    .filter((chip): chip is DerivedChip<T> => chip !== null)
}

/** "27 Aug", in the traveler's own calendar rather than a locale guess. */
function formatShortDate(date: string): string {
  const parsed = new Date(`${date}T00:00:00Z`)
  if (Number.isNaN(parsed.getTime())) return date
  return `${parsed.getUTCDate()} ${MONTHS[parsed.getUTCMonth()]}`
}

const MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
]

/** Adds `n` days to a YYYY-MM-DD string, in UTC — see dateShift.addDays. */
function addDays(date: string, n: number): string {
  const next = new Date(
    new Date(`${date}T00:00:00Z`).getTime() + n * 86_400_000,
  )
  return next.toISOString().slice(0, 10)
}
