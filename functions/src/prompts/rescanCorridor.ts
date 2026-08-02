import Anthropic from '@anthropic-ai/sdk'
import { z } from 'zod'
import { defineSecret } from 'firebase-functions/params'
import { estimateDetourKm, haversineDistanceKm, type LatLng } from '@rv/shared'
import { geocodeQuery } from '../placesApi.js'
import { logClaudeUsage } from '../claudeUsageLogger.js'
import { buildRescanCorridorPrompt } from './rescanCorridorPrompt.js'

export const claudeApiKey = defineSecret('CLAUDE_API_KEY')

const MODEL = 'claude-sonnet-5'
const MAX_ATTEMPTS = 2
/**
 * Don't START a retry once this much of the budget is gone.
 *
 * Each attempt is a Claude call with up to 3 web searches, so two of them
 * back to back can run for minutes — and did: a "Describe it" search was
 * reported taking four minutes and then failing, which is the client's own
 * 190s timeout firing mid-second-attempt. A retry that cannot finish before
 * the traveler is shown an error isn't resilience, it's just spend. One
 * slow-but-complete attempt beats two that get cut off.
 */
const RETRY_DEADLINE_MS = 100_000

/**
 * How large a "rescan this area" search radius is allowed to be, in
 * kilometres. This is a traveler-triggered, on-demand Claude + web-search
 * call with no per-trip cost guard (unlike full generation/replan, it never
 * touches `planMeta.status` or the days collection, so concurrent rescans
 * are merely redundant, not corrupting) — the radius cap is what keeps a
 * single call bounded, per master_plan.md's "explicit cap/viewport-scoping
 * story" requirement for this phase.
 */
export const MAX_RESCAN_RADIUS_KM = 50

/** Caps how many proposed stops one rescan can add — a single search
 * shouldn't be able to flood the corridor with dozens of unreviewed pins. */
export const MAX_RESCAN_RESULTS = 10

/**
 * When searching along a route backbone (see `backbone` below) instead of a
 * plain point+radius, this is the filter that replaces `radiusKm`: how far
 * off the corridor a find is allowed to sit, measured the same way
 * ExploreCandidateCard's own detour badges are (estimateDetourKm — cheapest
 * extra km via this point on top of whatever backbone leg it's nearest).
 * Deliberately smaller than MAX_RESCAN_RADIUS_KM: "along the route" implies
 * a genuinely minor detour, not a 50km side trip.
 */
export const MAX_QUERY_SEARCH_DETOUR_KM = 30

function stripCodeFences(text: string): string {
  return text
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/, '')
    .trim()
}

const rescanCandidateSchema = z.object({
  name: z.string(),
  country: z.string().length(2),
  why: z.string(),
})

const rescanResponseSchema = z.object({
  // May be empty — "nothing worthwhile nearby" is a real, expected outcome
  // for a point-and-radius search, not a validation failure.
  finds: z.array(rescanCandidateSchema),
})

export function parseRescanResponse(text: string) {
  return rescanResponseSchema.parse(JSON.parse(stripCodeFences(text)))
}

function textFromResponse(response: Anthropic.Message): string {
  return response.content
    .map((block) => (block.type === 'text' ? block.text : ''))
    .join('')
}

export interface RescanFind {
  name: string
  country: string
  why: string
  lat: number
  lng: number
}

/**
 * Searches near `center` for stops worth adding to the corridor, within
 * `radiusKm` — or, when `backbone` is given (2026-08-01, the explore-mode
 * route corridor — see buildRescanCorridorPrompt's own doc comment), along
 * that whole route instead, filtered by detour-off-backbone rather than
 * distance from one point. Each find is geocoded (still biased near
 * `center` either way — a reasonable bias point regardless of which filter
 * applies) and then actually measured server-side — a find that doesn't
 * geocode is dropped (nothing to check its distance/detour against).
 */
export async function generateRescanCandidates(input: {
  center: LatLng
  radiusKm: number
  notesFreeText?: string
  tripId?: string
  query?: string
  backbone?: LatLng[]
  centerName?: string
  waypointNames?: string[]
}): Promise<RescanFind[]> {
  const client = new Anthropic({ apiKey: claudeApiKey.value() })
  const { system, user } = buildRescanCorridorPrompt(input)
  const messages: Anthropic.MessageParam[] = [{ role: 'user', content: user }]

  let found: z.infer<typeof rescanResponseSchema> | undefined
  let lastError: unknown
  const startedAt = Date.now()
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    if (attempt > 0 && Date.now() - startedAt > RETRY_DEADLINE_MS) {
      console.warn(
        `Skipping rescan retry — ${Math.round((Date.now() - startedAt) / 1000)}s already spent`,
      )
      break
    }
    let response: Anthropic.Message
    const attemptStartedAt = Date.now()
    try {
      response = await client.messages.create({
        model: MODEL,
        // A focused query wants a handful of matches, not a survey — and
        // output length is paid for in wall time, on the call the traveler
        // is sitting and waiting for. The general "what's worth stopping
        // for here" pass still gets the full budget.
        max_tokens: input.query ? 1500 : 4000,
        thinking: { type: 'disabled' },
        system,
        messages,
        // Uncapped web_search bills every search result back in as input
        // tokens on top of the per-search fee — a rescan of one small area
        // never legitimately needs more than a couple of searches.
        tools: [{ type: 'web_search_20260209', name: 'web_search', max_uses: 3 }],
      })
    } catch (error) {
      // A transient API-level failure (rate limit, brief overload, network
      // blip), not Claude returning malformed JSON — MAX_ATTEMPTS existing
      // at all implies resilience to exactly this. Previously this threw
      // immediately on attempt 0 with no retry at all, surfacing as a
      // generic "Could not rescan this area right now" on the very first
      // transient blip. Retries the identical request unchanged.
      lastError = error
      continue
    }
    logClaudeUsage({
      callType: 'rescan',
      tripId: input.tripId,
      attempt,
      elapsedMs: Date.now() - attemptStartedAt,
      response,
    })
    const text = textFromResponse(response)

    try {
      found = parseRescanResponse(text)
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
  if (found.finds.length === 0) return []

  const located = await Promise.all(
    found.finds.map(async (find) => {
      try {
        const point = await geocodeQuery(`${find.name}, ${find.country}`, input.center)
        return point ? { ...find, ...point } : null
      } catch (error) {
        console.warn(`Geocoding rescan find "${find.name}, ${find.country}" failed — dropping it`, error)
        return null
      }
    }),
  )

  return filterFindsToCorridor(located, input)
}

/**
 * Drops finds that aren't actually where the traveler is looking — the same
 * measurement whether the find came from Claude or straight from Places, so
 * both paths honour the same "along this route" / "within this radius"
 * promise the form makes.
 */
export function filterFindsToCorridor(
  finds: (RescanFind | null)[],
  bounds: { center: LatLng; radiusKm: number; backbone?: LatLng[] },
): RescanFind[] {
  const useBackbone = bounds.backbone && bounds.backbone.length >= 2
  const filtered = finds.filter((find): find is RescanFind => {
    if (!find) return false
    if (useBackbone) {
      const detourKm = estimateDetourKm(find, bounds.backbone!)
      if (detourKm > MAX_QUERY_SEARCH_DETOUR_KM) {
        console.info(
          `Dropping rescan find "${find.name}" — ≈${Math.round(detourKm)} km detour off route (max ${MAX_QUERY_SEARCH_DETOUR_KM} km)`,
        )
        return false
      }
      return true
    }
    const distanceKm = haversineDistanceKm(find, bounds.center)
    if (distanceKm > bounds.radiusKm) {
      console.info(
        `Dropping rescan find "${find.name}" — ≈${Math.round(distanceKm)} km away (radius ${bounds.radiusKm} km)`,
      )
      return false
    }
    return true
  })

  return filtered.slice(0, MAX_RESCAN_RESULTS)
}
