import type { LatLng } from '@rv/shared'

/**
 * "Rescan this area" (phase 3 of the persistent-corridor overhaul,
 * 2026-07-29): unlike generateRegionHighlights (whole-trip curation), this is
 * a traveler-triggered, point-and-radius search — "what's worth stopping for
 * near where I'm looking right now on the map". No route exists yet to
 * filter against (the corridor may not even have a plan behind it — this is
 * explicitly usable from `idle` status onward), so the only constraint is
 * straight-line distance from the requested center, enforced server-side via
 * haversineDistanceKm after geocoding: no distances, no coordinates from the
 * model itself — only what's genuinely found.
 */
const RESCAN_SYSTEM_PROMPT = `You are an expert European tour guide specializing in RV travel for families. The traveler wants to know what's worth stopping for — either near one specific point they're looking at on the map, or along their route corridor as a whole — not a redesign of their trip, just genuinely good finds.

You will be given EITHER a center point (as a rough place description, not coordinates) and a search radius in kilometres, OR a routeWaypoints list describing the corridor roughly, plus the traveler's freeform notes about their trip if any.

Search for things like:
- Recently opened or recently reopened attractions, museums, parks, trails, and viewpoints.
- Local favourites and lesser-known spots: regional parks, small museums, swimming spots, farm visits, marked walks.
- Anything matching the traveler's stated interests and notes, if given.

If a "focusQuery" is given, it OVERRIDES the general guidance above: the traveler has asked for something specific (e.g. "coffee stop", "cozy small lunch place", "a playground") — search for real places matching THAT description specifically, not general tourist highlights. When routeWaypoints are given too, look ALONG that whole corridor, not just at one of the waypoints — a good coffee stop halfway between two waypoints is exactly what "along route" means. Still apply the same rigor: only genuinely real places found via web search, still nothing generic or invented.

Hard rules:
1. STAY CLOSE. When a center+radius is given, only propose places genuinely within that radius. When routeWaypoints are given instead, only propose places that are a small, reasonable detour off that route — not a place near one waypoint that would require backtracking far off the corridor to reach. Anything too far will be discarded server-side regardless of how good it is.
2. DO NOT invent or state exact distances, drive times, or coordinates — not in "why", not anywhere. Those are checked against real data after you respond. Describe where a place roughly is in words and stop there.
3. Ground every suggestion in something you actually found via web search. If nothing genuinely worthwhile turns up, respond with an empty "finds" list rather than padding it with generic suggestions.

The "why" for each find is what the traveler actually reads when deciding whether to keep it: 2-4 sentences describing what's genuinely there, what makes it worth the stop, and (if notes were given) how it connects to the traveler's stated interests.

Respond with JSON ONLY, matching this exact shape — no prose, no markdown code fences:
{
  "finds": [
    { "name": string, "country": string (ISO 2-letter code), "why": string (2-4 sentences, no invented distances or coordinates) }
  ]
}
If you have nothing to add, respond with { "finds": [] }.`

export function buildRescanCorridorPrompt(input: {
  center: LatLng
  radiusKm: number
  notesFreeText?: string
  // A traveler-typed description of what they're looking for (2026-08-01):
  // "coffee stop", "cozy small lunch place", etc. — see AddCorridorStopForm's
  // own doc comment for the UI this feeds. Optional: omitted, this call
  // behaves exactly as before (the general "what's worth stopping for"
  // pass a plain "Rescan this area" click still runs).
  query?: string
  // The explore-mode route corridor (start -> locked stops -> end, already
  // computed client-side by buildRouteBackbone — same shared util
  // ExploreCandidateCard's own detour badges use) — given instead of a bare
  // point+radius when the traveler searches from within explore mode, so
  // "coffee stop along route" actually reasons about the whole corridor
  // rather than just wherever the map happened to be panned. `center`/
  // `radiusKm` are still sent alongside (used as the geocoding bias point;
  // server-side filtering switches to detour-off-backbone instead of
  // distance-from-center when this is present — see generateRescanCandidates).
  backbone?: LatLng[]
  // Place NAMES for the same geography (2026-08-02). Sending only
  // coordinates was a real, measured mistake: asked for "a cozy restaurant
  // in Hillerød" near "latitude 55.93, longitude 12.31", the model spent its
  // entire web-search budget working out where that was before it could look
  // for a restaurant — minutes, then a timeout, on a question Claude answers
  // in two seconds when the town is named. Optional, and the coordinate form
  // remains as the fallback: reverse geocoding is best-effort client-side.
  centerName?: string
  waypointNames?: string[]
}): { system: string; user: string } {
  const namedRoute =
    input.waypointNames && input.waypointNames.length >= 2
      ? input.waypointNames
      : undefined
  const user = JSON.stringify({
    // Coordinates are still never sent for the model to reason numerically
    // with — distances and positions are checked server-side afterward,
    // biased near `center`. Naming the place is the opposite of inviting
    // invention: it's what lets the model search for somewhere real.
    ...(namedRoute
      ? { routeWaypoints: namedRoute }
      : input.backbone && input.backbone.length >= 2
      ? {
          routeWaypoints: input.backbone.map(
            (p) => `latitude ${p.lat.toFixed(2)}, longitude ${p.lng.toFixed(2)}`,
          ),
        }
      : {
          areaDescription:
            input.centerName ??
            `latitude ${input.center.lat.toFixed(2)}, longitude ${input.center.lng.toFixed(2)}`,
          radiusKm: input.radiusKm,
        }),
    notes: input.notesFreeText ?? '',
    ...(input.query ? { focusQuery: input.query } : {}),
  })

  return { system: RESCAN_SYSTEM_PROMPT, user }
}
