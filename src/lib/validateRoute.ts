import type { TripSettings } from '@rv/shared'

/**
 * A trip's `startPoint`/`endPoint` default to a blank `{ name: '', lat: 0,
 * lng: 0 }` (see the settings-inheritance feature — these two fields
 * specifically never carry over to a new trip) — a real-looking `{lat: 0,
 * lng: 0}` coordinate, not an obviously-missing one, so nothing downstream
 * naturally rejects it. Reported as "Generate overview"/"Find great stops"
 * silently returning zero stops with no explanation: Claude was asked to
 * plan a corridor from a real start point to (0, 0) — the Gulf of Guinea —
 * and reasonably found nothing worth flagging on that "route". Checked
 * before firing any of the corridor-generation callables (this one,
 * generateExploreHighlights, rescanCorridor's backbone use, and the full
 * generation) so the traveler gets a clear, free, instant message instead
 * of a wasted Claude call and a confusing empty result.
 */
function isLocated(point: { name: string; lat: number; lng: number }): boolean {
  if (point.name.trim() === '') return false
  // (0, 0) is the app's own "not set yet" sentinel, and it survives every
  // generic check — it's finite, in range, and a real place (the Gulf of
  // Guinea). A name alone is NOT enough: PlaceAutocompleteInput accepts a
  // typed name immediately and resolves its coordinates asynchronously, so
  // between those two steps — or permanently, if that lookup fails — a
  // point can be named but still sitting on the sentinel. Generating then
  // routes the trip at the equator, which is exactly the confusing
  // empty/nonsense result this guard exists to prevent.
  if (point.lat === 0 && point.lng === 0) return false
  return Number.isFinite(point.lat) && Number.isFinite(point.lng)
}

export function hasRoute(settings: Pick<TripSettings, 'startPoint' | 'endPoint'>): boolean {
  return isLocated(settings.startPoint) && isLocated(settings.endPoint)
}
