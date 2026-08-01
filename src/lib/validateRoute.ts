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
export function hasRoute(settings: Pick<TripSettings, 'startPoint' | 'endPoint'>): boolean {
  return settings.startPoint.name.trim() !== '' && settings.endPoint.name.trim() !== ''
}
