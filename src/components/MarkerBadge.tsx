interface MarkerBadgeProps {
  icon: string
  /** status === 'selected' — "this is actually in my plan", distinct from tap-to-view. */
  selected?: boolean
  /** Tap-to-view state (Day View's selectedPlace) — takes visual priority over `selected`. */
  highlighted?: boolean
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
export function MarkerBadge({ icon, selected, highlighted }: MarkerBadgeProps) {
  return (
    <div
      className={`flex h-8 w-8 items-center justify-center rounded-full border-2 bg-white text-base shadow-md transition-transform dark:bg-neutral-900 ${
        highlighted
          ? 'scale-125 border-orange-600 ring-2 ring-orange-400'
          : selected
            ? 'border-sky-600 ring-2 ring-sky-400'
            : 'border-neutral-300 dark:border-neutral-700'
      }`}
    >
      {icon}
    </div>
  )
}
