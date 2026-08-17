import type { EmptyCountry } from '@rv/shared'
import type { RegionHighlightsResponse } from './prompts/planTripSchema.js'

/**
 * Why a country the traveler chose ended up with nothing on the map.
 *
 * The shape moved to @rv/shared once it stopped being only a return value
 * and started being written onto the trip (planMeta.exploreLastEmptyCountries)
 * — re-exported here so the callers that already import it from this module
 * keep working, and so this file stays the one place the rule is computed.
 */
export type { EmptyCountry }
export type EmptyCountryReason = EmptyCountry['reason']

/**
 * The chosen countries that came back with nothing, and which kind of
 * nothing it was.
 *
 * Reported as "why is it dropping Estonia without a message even though it
 * is added as a country to visit". The honest answer was that nothing was
 * watching: `preferredCountries` was read by no code anywhere — it reached
 * Claude as one clause in a prompt and was never compared against the
 * result. A country could be left out by curation, or proposed and then lost
 * to failed map lookups, or dropped later by scheduling, and all three
 * arrived at the traveler as an absence.
 *
 * This closes the first two. Curation is now told that every chosen country
 * must appear in `regions` even when empty (see HIGHLIGHTS_SYSTEM_PROMPT), so
 * a country with a genuine reason carries it in `reasoning` and that reason
 * is passed straight through rather than paraphrased here.
 */
export function emptyPreferredCountries(
  preferredCountries: string[],
  highlights: RegionHighlightsResponse,
): EmptyCountry[] {
  const empty: EmptyCountry[] = []

  for (const country of preferredCountries) {
    const regions = highlights.regions.filter(
      (region) => region.country.toUpperCase() === country.toUpperCase(),
    )
    const candidates = regions.flatMap((region) => region.candidateStops)
    const located = candidates.filter(
      (candidate) => candidate.lat != null && candidate.lng != null,
    )
    if (located.length > 0) continue

    // A region returned for the country with nothing in it is curation
    // answering the question rather than ignoring it, so its reasoning is
    // the best explanation available — better than anything inferrable here.
    const note = regions.find((region) => region.reasoning.trim().length > 0)
      ?.reasoning

    empty.push({
      country,
      reason: candidates.length === 0 ? 'not-proposed' : 'not-located',
      proposed: candidates.length,
      ...(note ? { note } : {}),
    })
  }

  return empty
}
