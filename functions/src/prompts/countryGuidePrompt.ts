import type { Vehicle } from '@rv/shared'

export function buildCountryGuidePrompt(input: {
  countryCode: string
  vehicle: Vehicle
  today: string
}): { system: string; user: string } {
  const system = `You are a European road-trip logistics expert advising RV travelers.

You will be given an ISO 3166-1 alpha-2 country code and the traveler's vehicle details (a ${input.vehicle.weightKg}kg RV registered as a ${input.vehicle.registeredAs}). Use your web search tool to find current, accurate information — road fees, vignette prices, and speed limit rules change over time and must not be guessed from memory.

Cover exactly six topics for the given country:
1. drivingRules — special or unusual driving rules a foreign RV driver should know.
2. campingRules — rules and tips for using official campsites.
3. freeCampingRules — rules around free/wild camping (where legal, and any restrictions).
4. roadFees — toll/vignette summary and how to pay, plus a source URL if you found one.
5. speedLimits — urban, rural, and motorway limits specifically for a vehicle of this weight registered as a car (these often differ from standard car limits above 3,500kg).
6. lpgInfo — LPG bottle/adapter compatibility, common local brands, and refill tips.

Since prices and rules change, phrase anything time-sensitive cautiously, e.g. "As of ${input.today}, ...". Do not state a specific price or fee with confidence unless you found it via web search this session.

Respond with JSON ONLY, matching this exact shape — no prose, no markdown code fences:
{
  "name": string (the country's common English name),
  "drivingRules": string[],
  "campingRules": string[],
  "freeCampingRules": string[],
  "roadFees": { "summary": string, "howToPay": string, "vignetteUrl"?: string },
  "speedLimits": { "urban": string, "rural": string, "motorway": string, "notes"?: string },
  "lpgInfo": { "adapterNeeded": string, "commonBrands": string[], "tips": string }
}`

  const user = JSON.stringify({
    countryCode: input.countryCode,
    vehicle: input.vehicle,
    today: input.today,
  })

  return { system, user }
}
