import type { LatLng } from '@rv/shared'

export type ClaudeOvernightCandidateKind = 'stellplatz' | 'wild'

const KIND_INSTRUCTIONS: Record<ClaudeOvernightCandidateKind, string> = {
  // Only called when OpenStreetMap/Overpass found zero motorhome-stopover
  // (tourism=caravan_site + caravan_site=motorhome_stopover) results nearby
  // — i.e. genuinely sparse-coverage territory, not a first resort.
  stellplatz:
    'Find up to 3 known motorhome stopover parking areas (the German "Stellplatz" concept: simple, usually unstaffed motorhome parking with basic services — not a full campground) near the given coordinates. Use your web search tool to check for real, currently-operating locations — do not invent a name or address you have not found evidence for.',
  wild:
    "Find up to 3 places near the given coordinates where free/wild RV camping is plausible AND legal under this country's rules. Use your web search tool to check current local rules and any well-known suitable spots — legality of wild camping varies enormously by country and even by region, so be conservative: only suggest a spot if you have real grounds (a specific law, a well-documented custom, or a widely-corroborated report) to believe it's currently legal, and say so explicitly in the description.",
}

export function buildOvernightCandidatesPrompt(input: {
  kind: ClaudeOvernightCandidateKind
  near: LatLng
  country: string
  freeCampingRules?: string[]
}): { system: string; user: string } {
  const system = `You are an expert European RV-travel logistics advisor. ${KIND_INSTRUCTIONS[input.kind]}

Respond with JSON ONLY, matching this exact shape — no prose, no markdown code fences:
{
  "candidates": [
    { "name": string, "lat": number, "lng": number, "description": string (one to two sentences, cite why it's suitable/legal) }
  ]
}
If you find none you're confident about, respond with { "candidates": [] } rather than guessing.`

  const user = JSON.stringify({
    near: input.near,
    country: input.country,
    ...(input.freeCampingRules
      ? { knownFreeCampingRulesForThisCountry: input.freeCampingRules }
      : {}),
  })

  return { system, user }
}
