/** Section 7.2's zoom-based progressive disclosure tiers. */
export interface ZoomTiers {
  showOvernightStops: boolean
  showSelectedActivities: boolean
  showAllPlaces: boolean
}

export function getZoomTiers(zoom: number): ZoomTiers {
  return {
    showOvernightStops: zoom >= 6,
    showSelectedActivities: zoom >= 9,
    showAllPlaces: zoom >= 12,
  }
}
