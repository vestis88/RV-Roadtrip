import { defineSecret } from 'firebase-functions/params'
import type { LatLng } from '@rv/shared'

export const googleRoutesApiKey = defineSecret('GOOGLE_ROUTES_API_KEY')

export interface RouteLeg {
  distanceKm: number
  durationMin: number
  polyline?: string
}

const EARTH_RADIUS_KM = 6371
// Real driving distance is longer than the great-circle distance because
// roads bend around terrain/borders; 1.35x is a reasonable average for
// long-distance European highway routes.
const ROAD_DISTANCE_FACTOR = 1.35
// Assumed average speed for a 3,500kg RV mixing motorway and other roads.
const ASSUMED_AVG_SPEED_KMH = 75

function haversineKm(a: LatLng, b: LatLng): number {
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

function estimateRouteLeg(origin: LatLng, destination: LatLng): RouteLeg {
  const distanceKm = haversineKm(origin, destination) * ROAD_DISTANCE_FACTOR
  const durationMin = (distanceKm / ASSUMED_AVG_SPEED_KMH) * 60
  return { distanceKm, durationMin }
}

interface ComputeRoutesResponse {
  routes?: {
    distanceMeters?: number
    duration?: string
    polyline?: { encodedPolyline?: string }
  }[]
}

async function callRoutesApi(
  origin: LatLng,
  destination: LatLng,
  apiKey: string,
): Promise<RouteLeg> {
  const response = await fetch(
    'https://routes.googleapis.com/directions/v2:computeRoutes',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': apiKey,
        'X-Goog-FieldMask':
          'routes.distanceMeters,routes.duration,routes.polyline.encodedPolyline',
      },
      body: JSON.stringify({
        origin: { location: { latLng: origin } },
        destination: { location: { latLng: destination } },
        travelMode: 'DRIVE',
      }),
    },
  )

  if (!response.ok) {
    throw new Error(`Routes API responded with ${response.status}`)
  }

  const data = (await response.json()) as ComputeRoutesResponse
  const route = data.routes?.[0]
  if (!route?.distanceMeters || !route.duration) {
    throw new Error('Routes API response missing distance/duration')
  }

  return {
    distanceKm: route.distanceMeters / 1000,
    durationMin: parseInt(route.duration.replace('s', ''), 10) / 60,
    polyline: route.polyline?.encodedPolyline,
  }
}

/**
 * Computes a single drive leg. Uses the real Google Routes API when
 * GOOGLE_ROUTES_API_KEY is configured; otherwise (or on failure) falls back
 * to a haversine-based estimate so local dev/CI works without real
 * credentials, and so an API outage degrades a plan instead of failing it.
 */
export async function computeRouteLeg(
  origin: LatLng,
  destination: LatLng,
): Promise<RouteLeg> {
  const apiKey = googleRoutesApiKey.value()
  if (!apiKey) {
    return estimateRouteLeg(origin, destination)
  }
  try {
    return await callRoutesApi(origin, destination, apiKey)
  } catch (error) {
    console.warn('Routes API call failed, falling back to estimate', error)
    return estimateRouteLeg(origin, destination)
  }
}

export interface MultiLegTotals {
  legs: RouteLeg[]
  totalKm: number
  avgDriveMinutesPerDay: number
}

/** Computes each leg between consecutive points and summarizes the totals. */
export async function computeMultiLegTotals(
  points: LatLng[],
): Promise<MultiLegTotals> {
  const legs: RouteLeg[] = []
  for (let i = 0; i < points.length - 1; i++) {
    legs.push(await computeRouteLeg(points[i], points[i + 1]))
  }

  const totalKm = legs.reduce((sum, leg) => sum + leg.distanceKm, 0)
  const avgDriveMinutesPerDay = legs.length
    ? legs.reduce((sum, leg) => sum + leg.durationMin, 0) / legs.length
    : 0

  return { legs, totalKm, avgDriveMinutesPerDay }
}
