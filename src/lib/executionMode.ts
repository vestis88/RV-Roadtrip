export const BEHIND_PLAN_THRESHOLD_KM = 50

// Moved to @rv/shared (see shared/src/geo.ts): the highlights web-search
// enrichment pass needs the same distance maths server-side, and a second
// copy of it is exactly how the two ends drift apart. Re-exported here so
// this module's own callers keep importing it from where they always have.
export { haversineDistanceKm } from '@rv/shared'

export function shouldPromptReplan(
  distanceKm: number,
  thresholdKm: number = BEHIND_PLAN_THRESHOLD_KM,
): boolean {
  return distanceKm > thresholdKm
}

export function isTripActiveToday(
  today: string,
  startDate: string,
  endDate: string,
): boolean {
  return today >= startDate && today <= endDate
}
