import type { LatLng, TripSettings } from '@rv/shared'
import type { RegionHighlightsResponse } from './planTripSchema.js'

/**
 * The opt-in "search the web for more stops" pass (implemented 2026-07-28).
 * The base highlights call is knowledge-only, so it can't know about a museum
 * that opened last spring, a trail that reopened, or the small-town festival
 * a regional tourist board is currently promoting. This call gets a web
 * search tool and the already-curated shortlist, and is asked for the things
 * that pass genuinely couldn't have known — not a longer version of the same
 * list.
 *
 * It deliberately does NOT ask for coordinates or distances. Every other
 * Claude call in this codebase treats invented geography as worse than
 * missing geography (see planTripSchema's note on why lat/lng are geocoded
 * server-side, and DETAIL_SYSTEM_PROMPT's "do NOT invent ratings/hours"):
 * a model-supplied "about 20 km off the route" would read as authoritative
 * while being unfalsifiable, and it's precisely the number the caller uses
 * to decide what to keep. Towns are geocoded and each find's real detour
 * measured against the route afterward.
 */
const ENRICH_SYSTEM_PROMPT = `You are an expert European tour guide specializing in RV travel for families. A prioritized shortlist of candidate stops for this trip has ALREADY been researched from general knowledge. Your ONLY job now is to use your web search tool to find ADDITIONAL stops, near the route this shortlist implies, that the earlier pass would not have known about or is likely to have missed.

You will be given the trip's settings (start/finish points, preferred countries, travelers, interests), the traveler's freeform notes, the already-curated highlights, and "routeBackbone" — the ordered coordinates of the corridor the trip is currently built around (start, the must-see stops, finish).

Search for things like:
- Recently opened or recently reopened attractions, museums, parks, trails, and viewpoints.
- Local favourites and lesser-known spots that rarely make general-knowledge lists: regional parks, small museums, swimming spots, farm visits, marked walks.
- Anything specifically matching these travelers' stated interests, ages, and freeform notes.
- Seasonal or dated events that fall within this trip's dates.

Hard rules:
1. STAY NEAR THE CORRIDOR. Only propose towns close to the routeBackbone — a stop needs to be reachable as a modest detour off it, not a reason to redesign the trip. A place hundreds of kilometres off the corridor will be discarded, however good it is.
2. DO NOT re-list, rename, or restate anything already in the given highlights, and do not propose a town that is already there.
3. DO NOT invent or state exact distances, drive times, or coordinates — not in "why", not anywhere. Those are resolved from real data after you respond. Describe where a place roughly is in words ("in the valley just east of the main road south") and stop there.
4. Ground every suggestion in something you actually found via web search. If a search turns up nothing genuinely worthwhile near this corridor, respond with an empty "regions" list rather than padding it with generic suggestions or things you merely half-remember.
5. Group your finds into regions the same way the existing highlights are grouped, and use the same priority vocabulary:
   - "must-see": genuinely exceptional and worth real detour/time cost for these travelers' interests.
   - "worth-a-detour": strong candidate if the schedule allows.
   - "nice-if-convenient": fine to include only if it's already roughly on the way.

The "why" for each candidate is what the traveler actually reads when deciding whether to keep it, so make it substantial: 2-4 sentences that first describe what is genuinely there and what the place is like, then connect that to THESE travelers' interests, ages, and notes. Say what makes it a find — that it opened recently, that it's a local rather than a tourist fixture — since that's the reason it's being offered at all. Write it so someone who has never heard of the town could decide on it without looking it up elsewhere.

Respond with JSON ONLY, matching this exact shape — no prose, no markdown code fences:
{
  "regions": [
    {
      "region": string (a short descriptive name, e.g. "Southern Jutland coast"),
      "country": string (ISO 2-letter code),
      "reasoning": string (one to two sentences on what these finds add for these travelers),
      "candidateStops": [
        { "town": string, "country": string (ISO 2-letter code), "why": string (2-4 sentences, no invented distances or coordinates), "priority": "must-see" | "worth-a-detour" | "nice-if-convenient" }
      ]
    }
  ]
}
Every region you return must have at least one candidateStop. If you have nothing to add, respond with { "regions": [] }.`

export function buildEnrichHighlightsPrompt(input: {
  settings: TripSettings
  notesFreeText: string
  highlights: RegionHighlightsResponse
  backbone: LatLng[]
}): { system: string; user: string } {
  const user = JSON.stringify({
    settings: input.settings,
    notes: input.notesFreeText,
    // Towns only — the model has no use for the server-side geocoded
    // coordinates, and echoing them back invites it to invent its own.
    alreadyCuratedHighlights: input.highlights.regions.map((region) => ({
      region: region.region,
      country: region.country,
      candidateStops: region.candidateStops.map((stop) => ({
        town: stop.town,
        country: stop.country,
        priority: stop.priority,
      })),
    })),
    routeBackbone: input.backbone,
  })

  return { system: ENRICH_SYSTEM_PROMPT, user }
}
