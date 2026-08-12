import { haversineDistanceKm } from '@rv/shared'
import type { LatLng, OvernightStopCandidate } from '@rv/shared'

const OVERPASS_URL = 'https://overpass-api.de/api/interpreter'
const SEARCH_RADIUS_METERS = 30_000

/**
 * Points closer together than this collapse into one search circle. A
 * two-month trip revisits the same town on consecutive days constantly
 * (every rest day, every two-night stop), and each duplicate would otherwise
 * add four clauses to the query for results we already have. 0.1 degrees of
 * latitude is roughly 11km — well inside the 30km search radius, so nothing
 * is lost by merging.
 */
const DEDUPE_DECIMALS = 1

/**
 * How many search circles go into one HTTP request. Each point contributes
 * four clauses (node/way x stellplatz/parking), so this is ~80 clauses per
 * request — a large query, but one Overpass answers comfortably, and it
 * keeps a 60-day trip at three requests instead of sixty.
 */
const MAX_POINTS_PER_QUERY = 20

/** Overpass gets longer than its 25s default, since these queries are wide. */
const OVERPASS_QUERY_TIMEOUT_S = 60

interface OverpassElement {
  type: 'node' | 'way' | 'relation'
  id: number
  lat?: number
  lon?: number
  center?: { lat: number; lon: number }
  tags?: Record<string, string>
}

interface OverpassResponse {
  elements: OverpassElement[]
}

/** An OSM overnight place, before it has been assigned to any particular day. */
export interface OsmOvernightPlace {
  name: string
  kind: 'stellplatz' | 'wild'
  lat: number
  lng: number
  description: string
  /** `fee=no` — a stellplatz that is also a free option. */
  free: boolean
  /**
   * Tagged `caravan_site=motorhome_stopover`, the OSM wiki's near-verbatim
   * definition of a stellplatz. Used to rank rather than to filter — see
   * the query below for why.
   */
  explicitStopover: boolean
}

function overpassClauses(point: LatLng, radiusMeters: number): string {
  const around = `(around:${radiusMeters},${point.lat},${point.lng})`
  return [
    // Stellplatz. Deliberately filtered on `tourism=caravan_site` ALONE.
    // This used to also require `caravan_site=motorhome_stopover`, which is
    // the precise tag but a far less consistently applied one — mappers
    // routinely tag the parent and stop there, so requiring both discarded
    // real stellplatz and is the most likely reason results have been thin.
    // The sub-tag is kept as a ranking signal (see explicitStopover).
    `node["tourism"="caravan_site"]${around};`,
    `way["tourism"="caravan_site"]${around};`,
    // Free/informal overnight parking. OSM does not map "wild camping" —
    // nobody surveys a field — but it does map parking a motorhome is
    // explicitly allowed to use, which is what the traveler actually needs.
    // `highway=rest_area` is deliberately NOT included: every motorway
    // service area carries it and it would swamp everything else.
    `node["amenity"="parking"]["motorhome"~"^(yes|designated)$"]${around};`,
    `way["amenity"="parking"]["motorhome"~"^(yes|designated)$"]${around};`,
  ].join('')
}

function dedupePoints(points: LatLng[]): LatLng[] {
  const seen = new Set<string>()
  const unique: LatLng[] = []
  for (const point of points) {
    const key = `${point.lat.toFixed(DEDUPE_DECIMALS)},${point.lng.toFixed(DEDUPE_DECIMALS)}`
    if (seen.has(key)) continue
    seen.add(key)
    unique.push(point)
  }
  return unique
}

function toPlace(element: OverpassElement): OsmOvernightPlace | null {
  const lat = element.lat ?? element.center?.lat
  const lng = element.lon ?? element.center?.lon
  if (lat == null || lng == null) return null

  const tags = element.tags ?? {}
  const isCaravanSite = tags.tourism === 'caravan_site'
  const free = tags.fee === 'no'
  const explicitStopover = tags.caravan_site === 'motorhome_stopover'

  return {
    name:
      tags.name ??
      (isCaravanSite ? 'Unnamed motorhome stopover' : 'Motorhome parking'),
    kind: isCaravanSite ? 'stellplatz' : 'wild',
    lat,
    lng,
    description:
      tags.description ??
      (isCaravanSite
        ? 'Motorhome stopover (Stellplatz) — arrive/depart any time, minimal facilities, short max stay.'
        : 'Parking where motorhomes are explicitly allowed. Check local signage for overnight rules.'),
    free,
    explicitStopover,
  }
}

async function runOverpassQuery(points: LatLng[]): Promise<OsmOvernightPlace[]> {
  const query = `[out:json][timeout:${OVERPASS_QUERY_TIMEOUT_S}];(${points
    .map((point) => overpassClauses(point, SEARCH_RADIUS_METERS))
    .join('')});out center;`

  const response = await fetch(OVERPASS_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `data=${encodeURIComponent(query)}`,
  })
  if (!response.ok) {
    const body = await response.text().catch(() => '')
    throw new Error(
      `Overpass query failed with ${response.status}: ${body.slice(0, 500)}`,
    )
  }

  const data = (await response.json()) as OverpassResponse
  const places: OsmOvernightPlace[] = []
  for (const element of data.elements) {
    const place = toPlace(element)
    if (place) places.push(place)
  }
  return places
}

/**
 * Every OSM overnight place along a whole route, in as few requests as the
 * route allows (implemented 2026-08-12).
 *
 * The per-day version of this (one `around` query per day) is what made
 * resolving overnight options at generation time impossible: sixty days meant
 * sixty requests to a free, best-effort, no-SLA endpoint, and it was already
 * the source that hung and took the picker to a 504. Overpass is perfectly
 * happy to answer many search circles in a single union, so a trip of any
 * length costs a handful of requests instead of one per day.
 *
 * Deliberately built from plain `(around:r,lat,lon)` clauses — the exact
 * syntax already proven in production here — rather than the polyline form
 * of `around`, which would be one query for the whole trip but which could
 * not be verified from the development sandbox (its network policy blocks
 * overpass-api.de outright). The saving from three requests down to one is
 * not worth shipping unverified syntax on the critical path of a two-month
 * generation.
 *
 * ODbL requires attribution wherever this data is shown — see the
 * OSM_ATTRIBUTION constant the frontend renders next to these results.
 */
export async function searchOvernightOsmAlongRoute(
  points: LatLng[],
): Promise<OsmOvernightPlace[]> {
  const unique = dedupePoints(points)
  if (unique.length === 0) return []

  const batches: LatLng[][] = []
  for (let i = 0; i < unique.length; i += MAX_POINTS_PER_QUERY) {
    batches.push(unique.slice(i, i + MAX_POINTS_PER_QUERY))
  }

  const results = await Promise.all(
    batches.map((batch) =>
      runOverpassQuery(batch).catch((error: unknown) => {
        // One batch failing costs that stretch of the route its OSM results,
        // not the whole trip's. Places-sourced campsites are unaffected, so
        // those days still get options.
        console.warn(
          `Overnight OSM lookup: batch of ${batch.length} point(s) failed`,
          error,
        )
        return [] as OsmOvernightPlace[]
      }),
    ),
  )

  // The same site legitimately answers for several days' circles where they
  // overlap; keep one copy and let the per-day assignment decide who gets it.
  const byLocation = new Map<string, OsmOvernightPlace>()
  for (const place of results.flat()) {
    byLocation.set(`${place.lat},${place.lng}`, place)
  }
  return [...byLocation.values()]
}

/**
 * The `limit` OSM places of one kind nearest a given point, best first.
 *
 * Ranked by distance, but an explicitly-tagged motorhome stopover outranks a
 * bare caravan_site at the same sort of distance: relaxing the query to the
 * parent tag (see overpassClauses) widens the net at some cost in precision,
 * and this is where that cost is paid back.
 */
export function nearestOsmPlaces(
  places: OsmOvernightPlace[],
  near: LatLng,
  kind: OsmOvernightPlace['kind'],
  limit: number,
): OsmOvernightPlace[] {
  return places
    .filter((place) => place.kind === kind)
    .map((place) => ({
      place,
      km: haversineDistanceKm(near, { lat: place.lat, lng: place.lng }),
    }))
    .filter((entry) => entry.km <= SEARCH_RADIUS_METERS / 1000)
    .sort(
      (a, b) =>
        Number(b.place.explicitStopover) - Number(a.place.explicitStopover) ||
        a.km - b.km,
    )
    .slice(0, limit)
    .map((entry) => entry.place)
}

export function osmPlaceToCandidate(
  place: OsmOvernightPlace,
  country: string,
): OvernightStopCandidate {
  return {
    name: place.name,
    type: place.kind,
    lat: place.lat,
    lng: place.lng,
    country,
    description: place.free
      ? `${place.description} Free of charge (OSM: fee=no).`
      : place.description,
    source: 'osm',
  }
}

/**
 * Single-point stellplatz lookup, kept for the on-demand "find more" path in
 * the overnight picker — one day, resolved live, when the traveler wants
 * options beyond the ones already stored for that day. Shares the corridor
 * query's relaxed tag filter and ranking so the two can never disagree about
 * what counts as a stellplatz.
 */
export async function searchStellplatzCandidates(
  near: LatLng,
  country: string,
  limit: number,
): Promise<OvernightStopCandidate[]> {
  const places = await searchOvernightOsmAlongRoute([near])
  return nearestOsmPlaces(places, near, 'stellplatz', limit).map((place) =>
    osmPlaceToCandidate(place, country),
  )
}

export const __testing = { dedupePoints, toPlace, overpassClauses }
