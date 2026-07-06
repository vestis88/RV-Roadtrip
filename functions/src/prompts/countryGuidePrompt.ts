import type { Vehicle } from '@rv/shared'

function describeVehicle(vehicle: Vehicle): string {
  const parts = [`${vehicle.weightKg}kg`, `registered as a ${vehicle.registeredAs}`]
  if (vehicle.lengthM != null) parts.push(`${vehicle.lengthM}m long`)
  if (vehicle.heightM != null) parts.push(`${vehicle.heightM}m tall`)
  if (vehicle.widthM != null) parts.push(`${vehicle.widthM}m wide`)
  if (vehicle.fuel != null) parts.push(`${vehicle.fuel}-powered`)
  return parts.join(', ')
}

export function buildCountryGuidePrompt(input: {
  countryCode: string
  vehicle: Vehicle
  today: string
}): { system: string; user: string } {
  const system = `You are a European road-trip logistics expert advising RV travelers.

You will be given an ISO 3166-1 alpha-2 country code and the traveler's vehicle details (an RV: ${describeVehicle(input.vehicle)}). Use your web search tool to find current, accurate information — road fees, vignette prices, and speed limit rules change over time and must not be guessed from memory.

Cover exactly six topics for the given country:
1. drivingRules — special or unusual driving rules a foreign RV driver should know. Include any low-clearance tunnels, bridges, or roads this vehicle's height and width should specifically avoid or take care on.
2. campingRules — rules and tips for using official campsites.
3. freeCampingRules — rules around free/wild camping (where legal, and any restrictions).
4. roadFees — toll/vignette summary and how to pay, plus a source URL if you found one. Bridge and ferry crossings in this country are frequently priced in tiers by vehicle length and/or height (e.g. Norwegian car ferries and AutoPASS bridges/tunnels, Øresund/Storebælt-style crossings, Greek and Italian ferries) rather than a flat car rate — identify the length/height bracket this vehicle falls into and note the fee difference from a standard car where it's significant. Also note any fuel-based toll/ferry pricing differences (e.g. diesel vs. electric discounts) that apply to this vehicle's fuel type.
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
