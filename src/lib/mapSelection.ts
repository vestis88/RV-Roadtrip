import type { LatLng } from '@rv/shared'

/**
 * Where the plan map's camera belongs, given the two things that can be
 * selected on it.
 *
 * One camera, two origins. The map shows the day's activities and
 * restaurants AND the corridor stops still up for decision, and either can
 * be selected — from a pin, or (since 2026-08-19) from the list below the
 * map. Reported as "clicking a list item does not pan the map to the
 * corresponding pin": the panner was wired to the activity selection alone,
 * which was invisible while a corridor stop could only be selected by
 * tapping its own pin, because then the camera was already there. A list
 * gave the selection an origin the camera knew nothing about.
 *
 * A pure function rather than a ternary in the JSX because it cannot be
 * tested any other way: a pan needs a live Google map, which needs an API
 * key that CI does not have. The last layout regression on this screen
 * shipped for exactly that reason — the only assertions were about the part
 * that renders without a map.
 *
 * The corridor stop wins when both are somehow set, but the screen clears
 * each selection when the other is made, so "both" should not arise; the
 * precedence is a backstop, not a design.
 */
export function panTargetFor(
  corridorStop: LatLng | null,
  place: LatLng | null,
): LatLng | null {
  return corridorStop ?? place ?? null
}
