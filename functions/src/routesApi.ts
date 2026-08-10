import { defineSecret } from 'firebase-functions/params'
import {
  ASSUMED_AVG_SPEED_KMH,
  ROAD_DISTANCE_FACTOR,
  type LatLng,
} from '@rv/shared'

export const googleRoutesApiKey = defineSecret('GOOGLE_ROUTES_API_KEY')

export interface RouteLeg {
  distanceKm: number
  durationMin: number
  polyline?: string
}

const EARTH_RADIUS_KM = 6371
// ROAD_DISTANCE_FACTOR and ASSUMED_AVG_SPEED_KMH moved to @rv/shared when
// the explore-mode candidate list started estimating drive time client-side
// — same figures, one definition, so the estimate a traveler compares
// candidates by and the one a generated plan is paced by cannot drift.

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

