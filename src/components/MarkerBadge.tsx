import {
  DONE_PIN_CLASS,
  PRIORITY_PIN_CLASS,
  type MarkerPriority,
} from '../lib/mapIcons'

interface MarkerBadgeProps {
  icon: string
  /** status === 'selected' — "this is actually in my plan", distinct from tap-to-view. */
  selected?: boolean
  /** Tap-to-view state (Day View's selectedPlace) — takes visual priority over `selected`. */
  highlighted?: boolean
  /**
   * Interest level, for the explore map's candidate pins. Absent everywhere
   * else — a restaurant or an overnight stop has no such level, and giving
   * them a neutral ring is the point.
   */
  priority?: MarkerPriority
  /**
   * Already visited. Outranks the interest level — how much you once cared
   * about a place stops being the useful fact once you have been.
   */
  done?: boolean
}

/**
 * Bare emoji in an <AdvancedMarker> renders at default browser font size —
 * tiny and hard to tap, especially where restaurant clusters overlap at
 * street-level zoom. A sized, backgrounded badge fixes tap targets across
 * both DayViewScreen and OverviewMapScreen, and doubles as the one place
 * that renders the two kinds of "this one's different" a marker can be:
 * `selected` (status==='selected', a real plan commitment) and
 * `highlighted` (the traveler just tapped this card/pin to look at it).
 */
export function MarkerBadge({
  icon,
  selected,
  highlighted,
  priority,
  done,
}: MarkerBadgeProps) {
  // Ordered deliberately, and the two transient states still win. Tapping a
  // pin has to visibly answer the tap, and "this one is in my route" is a
  // decision the traveler has made — an interest level is a property of a
  // suggestion they are still weighing. A pin that stopped responding to
  // taps because it was green would be a worse map than one that shows the
  // level a moment later.
  const ring = highlighted
    ? 'scale-125 border-orange-600 ring-2 ring-orange-400'
    : selected
      ? 'border-sky-600 ring-2 ring-sky-400'
      : done
        ? DONE_PIN_CLASS
        : priority
          ? PRIORITY_PIN_CLASS[priority]
          : 'border-neutral-300 dark:border-neutral-700'
  return (
    <div
      className={`flex h-8 w-8 items-center justify-center rounded-full border-2 bg-white text-base shadow-md transition-transform dark:bg-neutral-900 ${
        done && !highlighted ? 'opacity-70' : ''
      } ${ring}`}
    >
      {icon}
    </div>
  )
}
