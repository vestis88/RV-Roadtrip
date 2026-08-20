// Moved to @rv/shared (see shared/src/geo.ts): the highlights web-search
// enrichment pass needs the same distance maths server-side, and a second
// copy of it is exactly how the two ends drift apart. Re-exported here so
// this module's own callers keep importing it from where they always have.
export { haversineDistanceKm } from '@rv/shared'

// `shouldPromptReplan` and its threshold moved to planDrift.ts on
// 2026-08-19. They took ONE number — straight-line distance to tonight's
// town — which cannot express being ahead of the plan, cannot say anything
// in days, and applies the same 50 km to a 200 km week and a 4,000 km month.
// What is left here is the one question that really is about the calendar
// alone.

export function isTripActiveToday(
  today: string,
  startDate: string,
  endDate: string,
): boolean {
  return today >= startDate && today <= endDate
}
