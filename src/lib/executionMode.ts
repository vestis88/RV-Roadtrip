import type { LatLng } from '@rv/shared'

const EARTH_RADIUS_KM = 6371
export const BEHIND_PLAN_THRESHOLD_KM = 50

export function haversineDistanceKm(a: LatLng, b: LatLng): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180
  const dLat = toRad(b.lat - a.lat)
  const dLng = toRad(b.lng - a.lng)
  const sinLat = Math.sin(dLat / 2)
  const sinLng = Math.sin(dLng / 2)
  const h =
    sinLat * sinLat +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * sinLng * sinLng
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(h))
}

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
