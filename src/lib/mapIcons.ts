import type { ActivityCategory } from '@rv/shared'

export const CATEGORY_ICON: Record<ActivityCategory, string> = {
  sight: '🏰',
  hike: '⛰️',
  museum: '🏛️',
  beach: '🌊',
  playground: '🎈',
  bike: '🚵',
  ski: '⛷️',
  other: '📍',
}
export const RESTAURANT_ICON = '🍴'
export const OVERNIGHT_ICON = '🛏️'
/**
 * A place this day COULD sleep, as opposed to the one it does.
 *
 * Requested 2026-09-02: *"I want the overnight stop options to show on the
 * map in a similar way as activities and restaurants."* Deliberately not the
 * bed: the chosen overnight and a candidate for it must be tellable apart at
 * a glance, or the map answers "where am I sleeping" with a dozen equal
 * pins. A tent is the option; the bed is the decision.
 */
export const OVERNIGHT_OPTION_ICON = '⛺'
export const CORRIDOR_PROPOSED_ICON = '🔍'
export const CORRIDOR_LOCKED_ICON = '📌'
export const CORRIDOR_CANDIDATE_ICON = '💡'
/**
 * A stop already visited (2026-08-24: "done things should be... only visible
 * as checked symbols on the map").
 *
 * Done stops used to draw the same lightbulb as everything else, so the only
 * thing marking one was its dimmed card in the list — which is exactly what
 * that request removes. Without this the pin would be the sole trace of a
 * finished stop and would look identical to one still ahead.
 */
export const CORRIDOR_DONE_ICON = '✅'
/**
 * An ephemeral result from "what's near us" (2026-08-24). Distinct from the
 * corridor pins on purpose: nothing behind one of these is part of the trip
 * until the traveler adds it, and a find that looked like a stop would make
 * the corridor seem to fill itself.
 */
export const LIVE_FIND_ICON = '🔎'

/**
 * The three interest levels, as pin colours (2026-08-17, requested:
 * "Green is must see. Yellow is worth a detour. Red is if convenient").
 *
 * Ring and border both, because the badge is small and a border alone reads
 * as grey at map zoom. Kept as whole class strings rather than composed from
 * a colour name — Tailwind scans source text for the class names it emits, so
 * a `border-${colour}-600` template produces classes that exist in no
 * stylesheet and pins that render unstyled.
 */
export const PRIORITY_PIN_CLASS = {
  'must-see': 'border-emerald-600 ring-2 ring-emerald-400',
  'worth-a-detour': 'border-amber-500 ring-2 ring-amber-300',
  'nice-if-convenient': 'border-rose-600 ring-2 ring-rose-400',
} as const

/**
 * Behind you rather than ahead. Grey, so a finished stop reads as settled
 * next to the green/amber/rose of everything still to decide.
 */
export const DONE_PIN_CLASS = 'border-neutral-400 ring-2 ring-neutral-300'

export type MarkerPriority = keyof typeof PRIORITY_PIN_CLASS
