/**
 * A duration in minutes, written the way a traveler reads a drive: "45 min"
 * below an hour, "6 h 20 min" above it, and "2 h" when it lands exactly on
 * one.
 *
 * Shared by the per-candidate detour badge (which prefixes a "+", since that
 * figure is an increment) and the route-totals bar (which does not, since
 * that one is an absolute). Same rounding either way — two formatters drift,
 * and a list showing "+1 h 20 min" above a total reading "1.33 h" looks like
 * two different measurements of the same drive.
 */
export function formatDriveTime(minutes: number): string {
  if (!Number.isFinite(minutes) || minutes <= 0) return '0 min'
  const rounded = Math.round(minutes)
  if (rounded < 60) return `${rounded} min`
  const hours = Math.floor(rounded / 60)
  const rest = rounded % 60
  return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`
}
