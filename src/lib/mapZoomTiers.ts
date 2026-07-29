/** Section 7.2's zoom-based progressive disclosure tiers. */
export interface ZoomTiers {
  showOvernightStops: boolean
  showSelectedActivities: boolean
  showAllPlaces: boolean
  // Proposed/locked corridor stops (phase 3, 2026-07-29) — coarse
  // route-level waypoints, same disclosure tier as overnight stops rather
  // than the denser activity/restaurant tiers.
  showCorridorStops: boolean
}

export function getZoomTiers(zoom: number): ZoomTiers {
  return {
    showOvernightStops: zoom >= 6,
    showSelectedActivities: zoom >= 9,
    showAllPlaces: zoom >= 12,
    showCorridorStops: zoom >= 6,
  }
}
