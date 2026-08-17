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
export const CORRIDOR_PROPOSED_ICON = '🔍'
export const CORRIDOR_LOCKED_ICON = '📌'
export const CORRIDOR_CANDIDATE_ICON = '💡'

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

export type MarkerPriority = keyof typeof PRIORITY_PIN_CLASS
