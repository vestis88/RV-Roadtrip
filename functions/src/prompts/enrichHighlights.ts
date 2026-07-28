import Anthropic from '@anthropic-ai/sdk'
import { z } from 'zod'
import { defineSecret } from 'firebase-functions/params'
import {
  buildRouteBackbone,
  estimateDetourKm,
  type LatLng,
  type TripSettings,
} from '@rv/shared'
import { geocodeQuery } from '../placesApi.js'
import { buildEnrichHighlightsPrompt } from './enrichHighlightsPrompt.js'
import {
  regionHighlightSchema,
  regionHighlightsResponseSchema,
  type RegionHighlight,
  type RegionHighlightCandidate,
  type RegionHighlightsResponse,
} from './planTripSchema.js'

export const claudeApiKey = defineSecret('CLAUDE_API_KEY')

const MODEL = 'claude-sonnet-5'
const MAX_ATTEMPTS = 2

/**
 * How far off the existing route a web-search find may sit before it's
 * discarded, in straight-line kilometres of extra driving (the cheapest
 * insertion into the current backbone — see @rv/shared's estimateDetourKm).
 *
 * The traveler asked for extra stops *near the route*, not for a different
 * trip: a find 300 km off the corridor isn't a detour, it's a redesign, and
 * silently mixing one into the review list turns "here are some more ideas"
 * into "here's a plan you didn't ask for". 100 km of straight-line detour is
 * roughly a half-day's extra driving on real roads (the estimate reads low
 * against actual routes), which is about the most a single opportunistic
 * stop can be worth on a fixed-date trip. Tune here — it's the one number
 * that decides how adventurous this feature is allowed to be.
 */
export const MAX_ENRICHMENT_DETOUR_KM = 100

function stripCodeFences(text: string): string {
  return text
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/, '')
    .trim()
}

/**
 * The base highlights response shape, built from the very same
 * regionHighlightSchema so finds merge straight into the existing structure
 * — with one deliberate difference: `regions` may be empty.
 *
 * regionHighlightsResponseSchema requires at least one region because a
 * curation pass that produces nothing has simply failed. A *search* pass
 * that produces nothing has done its job: there was nothing near this
 * corridor worth the traveler's extra time. Treating that as a validation
 * error would send the retry loop back to the model demanding it produce
 * something — which is precisely how you get fabricated suggestions from a
 * feature whose whole value is that its finds are real.
 */
const enrichedHighlightsResponseSchema = regionHighlightsResponseSchema.extend({
  regions: z.array(regionHighlightSchema),
})

export function parseEnrichedHighlights(text: string): RegionHighlightsResponse {
  return enrichedHighlightsResponseSchema.parse(JSON.parse(stripCodeFences(text)))
}

function textFromResponse(response: Anthropic.Message): string {
  return response.content
    .map((block) => (block.type === 'text' ? block.text : ''))
    .join('')
}

/**
 * The ordered corridor a set of highlights is built around: start, its
 * located must-sees sorted along the route, finish.
 *
 * The local glue for @rv/shared's type-agnostic buildRouteBackbone — the
 * frontend has the equivalent few lines over its own HighlightRegion type
 * (src/lib/estimateHighlightsRoute.ts). Only the extraction differs; the
 * geometry is shared so the km figure the traveler sees in the review panel
 * and the km figure this file filters on can't drift apart.
 */
export function buildHighlightsBackbone(
  settings: TripSettings,
  highlights: RegionHighlightsResponse,
): LatLng[] {
  const mustSees = highlights.regions.flatMap((region) =>
    region.candidateStops
      .filter(
        (stop) =>
          stop.priority === 'must-see' &&
          typeof stop.lat === 'number' &&
          typeof stop.lng === 'number',
      )
      .map((stop) => ({ lat: stop.lat as number, lng: stop.lng as number })),
  )

  return buildRouteBackbone(settings.startPoint, mustSees, settings.endPoint)
}

async function locateCandidate(
  candidate: RegionHighlightCandidate,
  near: LatLng,
): Promise<RegionHighlightCandidate> {
  try {
    const point = await geocodeQuery(
      `${candidate.town}, ${candidate.country}`,
      near,
    )
    return point ? { ...candidate, lat: point.lat, lng: point.lng } : candidate
  } catch (error) {
    console.warn(
      `Geocoding enrichment candidate "${candidate.town}, ${candidate.country}" failed — dropping it`,
      error,
    )
    return candidate
  }
}

/**
 * Opt-in extra pass between the highlights phase and the review pause
 * (implemented 2026-07-28): Claude searches the web for stops worth adding
 * near the corridor the curated highlights already imply, and each find is
 * weighed by how much extra driving it actually costs before it's offered.
 *
 * Returns REGIONS TO APPEND to the existing highlights, tagged
 * `source: 'search'` so the review panel can label them as web-search finds
 * rather than passing them off as hand-curated. Returns an empty list when
 * the search turns up nothing that survives the filter — never throws for
 * that case (an unsuccessful search is a normal outcome), but does throw if
 * the Claude call itself fails, which the caller is expected to treat as
 * "carry on with the curated highlights".
 *
 * Filtering, after the response validates:
 * 1. Every candidate is geocoded exactly the way generateRegionHighlights
 *    does it — Places text search, biased near startPoint (a single global
 *    bias point is enough to disambiguate town names at this scale).
 * 2. A candidate that didn't geocode is DROPPED, unlike in the base pass
 *    where it's kept without coordinates. There the model already judged the
 *    town worth listing against the trip as a whole; here the whole promise
 *    is "near your route", and a find whose location is unknown can't be
 *    checked against that. Letting it through unchecked would smuggle in
 *    exactly the far-flung suggestion the distance rule exists to keep out.
 * 3. A candidate whose detour off the backbone exceeds
 *    MAX_ENRICHMENT_DETOUR_KM is dropped.
 * 4. Regions left with no surviving candidates are dropped whole —
 *    regionHighlightSchema requires at least one candidateStop, so an empty
 *    region would fail validation when the edited highlights come back for
 *    the outline phase.
 */
export async function generateEnrichedHighlights(input: {
  settings: TripSettings
  notesFreeText: string
  highlights: RegionHighlightsResponse
  backbone: LatLng[]
}): Promise<RegionHighlight[]> {
  const client = new Anthropic({ apiKey: claudeApiKey.value() })
  const { system, user } = buildEnrichHighlightsPrompt(input)
  const messages: Anthropic.MessageParam[] = [{ role: 'user', content: user }]

  let found: RegionHighlightsResponse | undefined
  let lastError: unknown
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 8000,
      // Same reasoning as planTrip's calls: thinking tokens count against
      // max_tokens, and a schema-constrained JSON response shouldn't risk
      // spending the whole budget before emitting any of it.
      thinking: { type: 'disabled' },
      system,
      messages,
      tools: [{ type: 'web_search_20260209', name: 'web_search' }],
    })
    const text = textFromResponse(response)

    try {
      found = parseEnrichedHighlights(text)
      break
    } catch (error) {
      lastError = error
      messages.push({ role: 'assistant', content: text })
      messages.push({
        role: 'user',
        content: `Your last response failed validation: ${String(error)}. Return ONLY the corrected JSON matching the schema — no prose, no markdown code fences.`,
      })
    }
  }

  if (!found) throw lastError

  const near = input.settings.startPoint
  if (!near) return []

  const located = await Promise.all(
    found.regions.map(async (region) => ({
      ...region,
      candidateStops: await Promise.all(
        region.candidateStops.map((stop) =>
          locateCandidate({ ...stop, source: 'search' as const }, near),
        ),
      ),
    })),
  )

  const withinReach = located
    .map((region) => ({
      ...region,
      candidateStops: region.candidateStops.filter((stop) => {
        if (typeof stop.lat !== 'number' || typeof stop.lng !== 'number') {
          console.info(
            `Dropping web-search stop "${stop.town}" — no coordinates, so its detour can't be checked`,
          )
          return false
        }
        const detourKm = estimateDetourKm(
          { lat: stop.lat, lng: stop.lng },
          input.backbone,
        )
        if (detourKm > MAX_ENRICHMENT_DETOUR_KM) {
          console.info(
            `Dropping web-search stop "${stop.town}" — ≈${Math.round(detourKm)} km off the route (limit ${MAX_ENRICHMENT_DETOUR_KM} km)`,
          )
          return false
        }
        return true
      }),
    }))
    .filter((region) => region.candidateStops.length > 0)

  return withinReach
}
