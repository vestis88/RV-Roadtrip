import type { LatLng, OvernightStopCandidate } from '@rv/shared'

const OVERPASS_URL = 'https://overpass-api.de/api/interpreter'
const SEARCH_RADIUS_METERS = 30_000

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

/**
 * Stellplatz lookup (implemented 2026-07-27): Google Places has weak-to-no
 * structured coverage of European motorhome-stopover parking, but
 * OpenStreetMap has a purpose-built tag for exactly this —
 * tourism=caravan_site + caravan_site=motorhome_stopover (arrive/depart any
 * time, no reception desk, minimal sanitary facilities, short max-stay —
 * the OSM wiki's own definition is a near-verbatim match for a stellplatz).
 * Queried via the public Overpass API (free, no auth, ~1M requests/day per
 * server, standard tool for this exact kind of geo-tagged POI search).
 *
 * ODbL requires attribution wherever this data is shown — see the
 * OSM_ATTRIBUTION constant the frontend renders next to these results.
 */
export async function searchStellplatzCandidates(
  near: LatLng,
  country: string,
  limit: number,
): Promise<OvernightStopCandidate[]> {
  const query = `[out:json][timeout:25];(node["tourism"="caravan_site"]["caravan_site"="motorhome_stopover"](around:${SEARCH_RADIUS_METERS},${near.lat},${near.lng});way["tourism"="caravan_site"]["caravan_site"="motorhome_stopover"](around:${SEARCH_RADIUS_METERS},${near.lat},${near.lng}););out center ${limit};`

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
  const candidates: OvernightStopCandidate[] = []
  for (const element of data.elements) {
    const lat = element.lat ?? element.center?.lat
    const lng = element.lon ?? element.center?.lon
    if (lat == null || lng == null) continue
    candidates.push({
      name: element.tags?.name ?? 'Unnamed motorhome stopover',
      type: 'stellplatz',
      lat,
      lng,
      country,
      description:
        element.tags?.description ??
        'Motorhome stopover (Stellplatz) — arrive/depart any time, minimal facilities, short max stay.',
      source: 'osm',
    })
    if (candidates.length >= limit) break
  }
  return candidates
}
