import type { CountryBriefSection, Vehicle } from './schemas.js'

/**
 * Referenced by name from the backend (the wild-camping prompt reads this
 * section's findings when it has them), so it isn't a free-form string.
 */
export const FREE_CAMPING_SECTION_ID = 'free-camping-rules'


/**
 * The research brief: what the traveler wants looked up for every country
 * they pass through. Six built-in sections, each independently researched —
 * adding a seventh costs one section's worth of Claude, and never
 * re-researches the six that were already answered.
 *
 * One list for all countries, by design (asked for 2026-08-02): a research
 * item is nearly always about how *this* traveler travels ("where can I
 * refill drinking water") rather than about one country, so maintaining a
 * per-country copy would mean re-adding the same item 12 times.
 *
 * `dependsOnVehicle` is what makes cross-trip reuse safe. A section whose
 * answer changes with the RV — clearances, weight-banded speed limits,
 * length-banded ferry tiers — is cached per vehicle, so changing the RV
 * re-researches those and *only* those. Camping rules and LPG brands are
 * the same whatever you drive, so they're cached per country and shared.
 */
export const DEFAULT_COUNTRY_BRIEF_SECTIONS: CountryBriefSection[] = [
  {
    id: 'driving-rules',
    title: 'Driving rules',
    brief:
      'Special or unusual driving rules a foreign RV driver should know. Include any low-clearance tunnels, bridges, or roads this vehicle’s height and width should specifically avoid or take care on.',
    dependsOnVehicle: true,
  },
  {
    id: 'camping-rules',
    title: 'Camping rules',
    brief: 'Rules and tips for using official campsites.',
    dependsOnVehicle: false,
  },
  {
    id: FREE_CAMPING_SECTION_ID,
    title: 'Free camping rules',
    brief:
      'Rules around free/wild camping — where it is legal, and any restrictions.',
    dependsOnVehicle: false,
  },
  {
    id: 'road-fees',
    title: 'Road fees',
    brief:
      'Toll and vignette summary and how to pay, with a source URL if you find one. Bridge and ferry crossings are frequently priced in tiers by vehicle length and/or height (Norwegian car ferries and AutoPASS crossings, Øresund/Storebælt, Greek and Italian ferries) rather than a flat car rate — identify the bracket this vehicle falls into and note the difference from a standard car where it is significant. Note any fuel-based toll or ferry discounts that apply to this vehicle’s fuel type.',
    dependsOnVehicle: true,
  },
  {
    id: 'speed-limits',
    title: 'Speed limits',
    brief:
      'Urban, rural and motorway limits specifically for a vehicle of this weight registered as a car — these often differ from standard car limits above 3,500kg.',
    dependsOnVehicle: true,
  },
  {
    id: 'lpg-info',
    title: 'LPG info',
    brief:
      'LPG bottle and adapter compatibility, common local brands, and refill tips.',
    dependsOnVehicle: false,
  },
]

/**
 * FNV-1a, 32-bit. Deliberately not `crypto` — this same function has to
 * produce the same key in the browser (to know which cached doc to read)
 * and in a Cloud Function (to know which one to write), and the two have
 * different crypto APIs. It's a cache key, not a security boundary.
 */
export function stableHash(text: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

/**
 * The vehicle attributes that can change an answer. Trip name, dates and
 * travelers deliberately don't appear: two trips in the same RV should hit
 * the same cached research, which is the whole point of storing it outside
 * the trip.
 */
export function vehicleKey(vehicle: Vehicle): string {
  return stableHash(
    JSON.stringify([
      vehicle.weightKg,
      vehicle.registeredAs,
      vehicle.heightM ?? null,
      vehicle.lengthM ?? null,
      vehicle.widthM ?? null,
      vehicle.fuel ?? null,
    ]),
  )
}

/**
 * Where one researched section lives. Everything that could change the
 * answer is in the key, so a hit is always safe to reuse and a change is
 * never silently served stale:
 *
 * - `countryCode` and `sectionId` — the obvious axes.
 * - the brief's own hash — editing what you asked for gets its own cache
 *   entry rather than overwriting the shared one (briefs are per-traveler,
 *   the cache is not), and everyone still on the default brief keeps
 *   sharing a single entry.
 * - the vehicle key, only for vehicle-dependent sections. `'any'` otherwise,
 *   so camping rules researched on one trip serve every other trip and
 *   every other vehicle.
 */
export function countryGuideSectionDocId(input: {
  countryCode: string
  section: CountryBriefSection
  vehicle: Vehicle
}): string {
  const { countryCode, section, vehicle } = input
  const scope = section.dependsOnVehicle ? vehicleKey(vehicle) : 'any'
  return `${countryCode}_${section.id}_${scope}_${stableHash(section.brief)}`
}
