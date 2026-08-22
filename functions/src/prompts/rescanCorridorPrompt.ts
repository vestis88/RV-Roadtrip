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

You will be given EITHER a center point (as a rough place description, not coordinates) and a search radius in kilometres, OR a routeWaypoints list describing the corridor roughly, plus this trip's stated "interests" and the traveler's freeform notes.

Work in this order:
1. Take the stated interests and notes ONE AT A TIME and ask where that interest is genuinely best served inside this area. Name the place someone who knows the subject would name if asked "where do you go for this around here?" — the bike park, the ski area, the climbing crag, the swimming spot, the trailhead, the museum. An interest like downhill mountain biking is answered by the actual bike park, not by a scenic trail or a viewpoint near one. Read the traveler's own word for it in context: "downhill" is a bike park to one group and a ski area to another, and the notes and the season tell you which.
2. Then add anything else genuinely worth stopping for in the same area — local favourites and lesser-known spots as readily as famous ones: regional parks, small museums, swimming spots, farm visits, marked walks, viewpoints.

If a "focusQuery" is given, it OVERRIDES the ordering above: the traveler has asked for something specific (e.g. "coffee stop", "cozy small lunch place", "a playground") — propose real places matching THAT description specifically, not general tourist highlights. When routeWaypoints are given too, look ALONG that whole corridor, not just at one of the waypoints — a good coffee stop halfway between two waypoints is exactly what "along route" means.

Hard rules:
1. STAY CLOSE. When a center+radius is given, only propose places genuinely within that radius. When routeWaypoints are given instead, only propose places that are a small, reasonable detour off that route — not a place near one waypoint that would require backtracking far off the corridor to reach. Anything too far will be discarded server-side regardless of how good it is.
1a. THE RADIUS WINS OVER THE AREA NAME. "areaDescription" is whatever the map centre reverse-geocodes to, and it is often the name of something far larger than the circle — a district, a valley, a municipality. It tells you WHERE the centre is, never how much ground to cover. If the radius is small, the well-known highlights of the wider region are the wrong answer even though they are the best-known places in it: they will be measured against the circle and discarded.
1d. "alreadyOnTheList" IS THE TRAVELER'S LIST. Those stops are already saved on this trip. Do not propose them again — a second card for a place they have already judged is worse than nothing, because they may have judged it and kept it, or judged it and turned it down. And say "already on your list", "already on your radar" or anything of that kind ONLY about a name that appears on it. If the list is absent you do not know what is on it, so do not refer to it at all: the traveler reads that phrase as "this is already a stop" and goes looking for it.
1c. "placesInArea" IS A FLOOR, NOT A CEILING. When it is given, it lists places Google Maps has a listing for inside the circle — everything on it is genuinely in there, which is why it is useful when the circle is small. It is NOT the complete set of what is worth stopping for: Google has no listing for most trailheads, swimming spots, free-camping pull-offs, viewpoints and local favourites, and it ranks what it does have by review count rather than by whether anyone should go. So use it as evidence about what is there, pick the ones worth stopping for, ignore the ones that are not — and go on adding the places YOU know are inside that circle, whether or not they appear on it. A good answer that Google has never heard of is exactly what this search is for. Never treat absence from the list as evidence that something is not there, or that an area is empty.
1b. A SMALL RADIUS IS ANSWERED BY ORDINARY THINGS. Within a few kilometres of a point there is rarely a famous sight, and that is not the same as nothing to do. The lake itself and where you can swim in it or launch a boat, the marked trail from the car park, the viewpoint, the gorge walk, the mountain hut, the cable car station, the campsite, the one restaurant in the hamlet — these are real answers and a traveler parked there wants them. Name them at the scale the radius asks for. Reserve an empty list for genuinely empty ground, not for ground that merely has nothing famous on it.
2. DO NOT invent or state exact distances, drive times, or coordinates — not in "why", not anywhere. Those are checked against real data after you respond. Describe where a place roughly is in words and stop there.
3. "name" MUST be the real, searchable name of a real place, spelled the way Google Maps would have it (e.g. "Vallåsen Bike Park", "Hovs Hallar", "Klässbols Linneväveri"). Every name is looked up against real map data after you respond and DISCARDED if it can't be found, so a generic entry ("a nice forest walk", "a local café") is a wasted one — name the park, the operator, the trailhead, the resort's own base area.
4. Do not pad. If this area genuinely has nothing worth stopping for, an empty "finds" list is a valid and honest answer. But "I am not certain enough" is not the same as "there is nothing here": propose the place you would name to a friend and let the map-data check be the thing that rejects it.

The "why" for each find is what the traveler actually reads when deciding whether to keep it: 2-4 sentences describing what's genuinely there, what makes it worth the stop, and which of the traveler's stated interests or notes it answers.

Respond with JSON ONLY, matching this exact shape — no prose, no markdown code fences:
{
  "finds": [
    { "name": string, "country": string (ISO 2-letter code), "why": string (2-4 sentences, no invented distances or coordinates) }
  ]
}
If you have nothing to add, respond with { "finds": [] }.`

/**
 * How many existing stop names to send. A long corridor can carry dozens;
 * this is context the model reads rather than reasons over, and the ones
 * that matter for "do not propose it twice" are the ones near this search.
 */
const MAX_EXISTING_STOPS = 60

export function buildRescanCorridorPrompt(input: {
  center: LatLng
  radiusKm: number
  notesFreeText?: string
  /**
   * The trip's own stated interests — the single most important input to
   * "what's worth stopping for here", and the one this prompt never
   * received (2026-08-16).
   *
   * Reported with a rescan of the Hallandsåsen area that answered "Nothing
   * new found nearby" for a trip whose stated interest is downhill mountain
   * biking, with Vallåsen Bike Park inside the searched circle. It was never
   * a search problem: the search was never told what the traveler came for.
   * All this call had was `notes` — which on that trip say "cozy over
   * mainstream" and "good coffee" — so it answered the question it was
   * actually asked. The whole-trip curation phase gets the full settings and
   * proposes bike parks correctly; this is the same fix, one call later.
   */
  interests?: string[]
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
  // Place NAMES for the same geography (2026-08-02). A traveler's own query
  // always named its town if it had one — it arrives verbatim in focusQuery
  // — so this is not what made those searches slow (that was web-search
  // grounding; see querySearch.ts). It matters for the geography the APP
  // supplies: a plain "Rescan this area" whose only anchor was a pair of
  // decimals, and hard rule 1's "is this a small detour off the corridor?",
  // asked against up to 50 more of them. Optional, and the coordinate form
  // remains as the fallback: reverse geocoding is best-effort client-side.
  centerName?: string
  waypointNames?: string[]
  /**
   * Every notable place Google Maps knows of inside the circle, from a
   * `locationRestriction` sweep (see searchPlacesInArea).
   *
   * The fix for three consecutive reports of a small circle coming back
   * empty. Without it the model is asked to recall what is within a few
   * kilometres of a reverse-geocoded name, holding no coordinates and no
   * tools — a fair question at 150 km and an impossible one at 6, which it
   * answered the only way it could: with the best-known places of the wider
   * region, all of which the distance filter then discarded.
   *
   * Absent for a backbone search (a corridor is not a circle) and for typed
   * queries (querySearch.ts is already Places-first), and absent whenever
   * the sweep fails — in which case this prompt behaves exactly as it did.
   */
  placesInArea?: string[]
  /**
   * The stops this trip already has.
   *
   * Reported 2026-08-22: cards reading "Already on your list — …" from a
   * traveler who could not find any such stop. They were right to look —
   * this prompt has never carried the corridor's stops, so the model had
   * nothing to be referring to except a line in the freeform notes, which is
   * not a stop, or nothing at all. Sending them makes the claim checkable
   * and stops the same place being proposed twice.
   */
  existingStopNames?: string[]
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
    ...(input.placesInArea && input.placesInArea.length > 0
      ? { placesInArea: input.placesInArea }
      : {}),
    ...(input.existingStopNames && input.existingStopNames.length > 0
      ? { alreadyOnTheList: input.existingStopNames.slice(0, MAX_EXISTING_STOPS) }
      : {}),
    interests: input.interests ?? [],
    notes: input.notesFreeText ?? '',
    ...(input.query ? { focusQuery: input.query } : {}),
  })

  return { system: RESCAN_SYSTEM_PROMPT, user }
}
