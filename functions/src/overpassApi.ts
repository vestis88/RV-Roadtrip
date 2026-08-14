import { haversineDistanceKm } from '@rv/shared'
import type { LatLng, OvernightStopCandidate } from '@rv/shared'

/**
 * Overpass endpoints, tried in order until one answers.
 *
 * A second endpoint exists because of what the first one actually did
 * (diagnosed from production logs 2026-08-13): overpass-api.de's front-end
 * Apache answered `406 Not Acceptable` — an HTML error page, not an Overpass
 * response — to every single request this app has ever sent it. Not a
 * timeout, not a rejected query: the query never reached Overpass at all.
 * Since the app has exactly one OSM source, one endpoint deciding to refuse
 * us means the Stellplatz and free-parking sections are empty for every day
 * of every trip, which is precisely what happened.
 *
 * kumi.systems is the long-standing public mirror, run by a sponsor of the
 * project and listed on the OSM wiki's Overpass API page. It is the fallback
 * rather than the primary because overpass-api.de is the reference instance
 * and the one whose behaviour is documented.
 */
const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
]

/**
 * The 406 above is what a request identifying itself as `node` gets.
 *
 * Node's global fetch sends `user-agent: node` when nothing else is set —
 * verified by inspecting the headers it actually puts on the wire, since
 * overpass-api.de is unreachable from the development sandbox. A generic
 * runtime name is not an identifying agent, and the OSM Foundation's API
 * usage policy requires one: it is how an instance operator contacts whoever
 * is hammering them instead of simply blocking the traffic. Public Overpass
 * front-ends enforce that with a filter, and a filter is what answered 406.
 *
 * So this is not a workaround — it is the thing the policy asked for, and
 * the app was anonymous by omission rather than by choice.
 */
const OVERPASS_USER_AGENT =
  'RV-Roadtrip/1.0 (motorhome trip planner; +https://github.com/vestis88/RV-Roadtrip)'

/**
 * A hung connection is the other way this source has taken a caller down (see
 * overnightCandidatesCallable's SOURCE_TIMEOUT_MS, written after two 504s at
 * 179.9999s). `[timeout:]` in the query only binds Overpass's own execution;
 * it does nothing about a socket that never answers, and the corridor path
 * runs inside generatePlan where there is no per-source deadline at all.
 * Comfortably longer than OVERPASS_QUERY_TIMEOUT_S so a query Overpass is
 * genuinely still working on is never cut off by this.
 */
const OVERPASS_HTTP_TIMEOUT_MS = 75_000

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
 *
 * Left at 20 deliberately after the 2026-08-13 investigation. The obvious
 * suspicion was that batching this wide was too expensive and was being
 * rejected, but the production failures were a *three*-point batch (twelve
 * clauses) getting the same 406 as the old one-point-per-request code did.
 * The rejection is at the HTTP front-end and has nothing to do with query
 * cost, so shrinking batches would have cost every trip more requests
 * against a free endpoint and fixed nothing.
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

async function postOverpass(
  endpoint: string,
  query: string,
): Promise<OsmOvernightPlace[]> {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      // Both deliberate. See OVERPASS_USER_AGENT for what identifying
      // ourselves fixed; `Accept` is stated rather than left to the runtime
      // default of `*/*` because the endpoint that refused us did so with an
      // Apache content-negotiation status, and asking for exactly the format
      // `[out:json]` produces removes any question about what we will take.
      'User-Agent': OVERPASS_USER_AGENT,
      Accept: 'application/json',
    },
    body: `data=${encodeURIComponent(query)}`,
    signal: AbortSignal.timeout(OVERPASS_HTTP_TIMEOUT_MS),
  })
  if (!response.ok) {
    const body = await response.text().catch(() => '')
    // The status is what identifies the failure — 406 meant "the front-end
    // refused us", 429 means "slow down", 504 means "the query was too big"
    // — so it leads the message, and enough of the body follows to tell an
    // Overpass error apart from a proxy's HTML error page.
    throw new Error(
      `Overpass query failed with ${response.status}: ${body.slice(0, 300)}`,
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
 * One batch of search circles, asked of each endpoint in turn until one
 * answers.
 *
 * Rotating endpoints IS the retry here: the failure this was written for was
 * a front-end refusing every request identically, which no amount of backing
 * off against that same host would have survived. A transient 429 or 504 is
 * served just as well by asking the mirror, so there is one attempt per
 * endpoint and no separate retry loop — which also keeps the worst case
 * bounded at two requests per batch, inside the callers' own deadlines.
 */
async function runOverpassQuery(points: LatLng[]): Promise<OsmOvernightPlace[]> {
  const query = `[out:json][timeout:${OVERPASS_QUERY_TIMEOUT_S}];(${points
    .map((point) => overpassClauses(point, SEARCH_RADIUS_METERS))
    .join('')});out center;`

  const failures: string[] = []
  for (const endpoint of OVERPASS_ENDPOINTS) {
    try {
      return await postOverpass(endpoint, query)
    } catch (error) {
      failures.push(
        `${endpoint}: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }
  // Every endpoint named, with its own status. Which one refused and how is
  // the whole diagnosis — "OSM returned nothing" is what made this bug
  // invisible for three days.
  throw new Error(`Overpass unreachable at every endpoint. ${failures.join(' | ')}`)
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
        return null
      }),
    ),
  )

  // The silence this replaces is the reason a total outage ran for three
  // days unnoticed (2026-08-10 to 2026-08-13). Every batch was being refused
  // with a 406, each one logged as a lone WARNING among a generation's worth
  // of chatter, and the traveler simply saw a picker with no Stellplatz and
  // no Wild camping section — indistinguishable from a stretch of road that
  // genuinely has neither. North Zealand plainly has caravan sites, so that
  // empty section should have been a signal rather than a shrug.
  //
  // Logged at ERROR precisely so it is greppable on its own: "no OSM results
  // anywhere on this route" is a statement about our access to OpenStreetMap,
  // not about the route.
  const failed = results.filter((result) => result === null).length
  if (failed === batches.length) {
    console.error(
      `Overnight OSM lookup UNAVAILABLE: all ${batches.length} batch(es) covering ` +
        `${unique.length} point(s) were refused. Every day of this trip will be ` +
        `missing its Stellplatz and free-parking options; campsites from Places ` +
        `are unaffected. See the per-batch warnings above for the endpoints and ` +
        `status codes.`,
    )
  } else if (failed > 0) {
    console.error(
      `Overnight OSM lookup DEGRADED: ${failed} of ${batches.length} batch(es) ` +
        `were refused, so part of the route has no Stellplatz or free-parking ` +
        `options for reasons that are ours, not the route's.`,
    )
  }

  // The same site legitimately answers for several days' circles where they
  // overlap; keep one copy and let the per-day assignment decide who gets it.
  const byLocation = new Map<string, OsmOvernightPlace>()
  for (const place of results.flat()) {
    if (place) byLocation.set(`${place.lat},${place.lng}`, place)
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
 * options beyond the ones already stored for that day. Shares `runOverpassQuery`
 * (and through it `overpassClauses`) and `nearestOsmPlaces` with the corridor
 * path, so the two can never disagree about what counts as a stellplatz.
 *
 * Deliberately NOT routed through searchOvernightOsmAlongRoute, which absorbs
 * a refused batch into an empty list. That absorption is right for a whole
 * corridor — one bad stretch must not cost the other fifty-nine days their
 * results — and wrong here, where the batch IS the request: swallowing it
 * hands the caller "no stellplatz near this town" when the truth is "OSM
 * never answered". Letting it throw is what puts the endpoint and status back
 * in the log line the callable already writes ("stellplatz search (Overpass)
 * failed"), which is the line the 2026-08-13 diagnosis was made from and
 * which routing through the corridor helper had quietly removed. The caller
 * still degrades to its Claude fallback either way — see
 * overnightCandidatesCallable's withDeadline.
 */
export async function searchStellplatzCandidates(
  near: LatLng,
  country: string,
  limit: number,
): Promise<OvernightStopCandidate[]> {
  const places = await runOverpassQuery([near])
  return nearestOsmPlaces(places, near, 'stellplatz', limit).map((place) =>
    osmPlaceToCandidate(place, country),
  )
}

export const __testing = { dedupePoints, toPlace, overpassClauses }
