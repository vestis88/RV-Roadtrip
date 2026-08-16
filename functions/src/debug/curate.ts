/**
 * Runs the real curation phase against the real APIs and prints what it
 * produced — the whole tool, and the whole point of it.
 *
 * Written after a trip whose stated interest was downhill mountain biking
 * came back with none of the bike parks. Diagnosing that took reading the
 * prompt and reasoning about what it must have done, because there was no
 * way to ASK: the only route to a real curation run was the deployed app,
 * from a phone, writing to the traveler's own trip. So the two hypotheses
 * that matter — "the resorts were never proposed" versus "they were proposed
 * and then dropped by verification" — could not be told apart, and they have
 * completely different fixes.
 *
 * This makes that a thirty-second question. It calls generateRegionHighlights
 * directly: same prompt, same model, same Places verification as production,
 * with no Firestore, no trip, no emulator and nothing written anywhere.
 *
 * Usage:
 *   cp .env.debug.local.example .env.debug.local   # then put real keys in it
 *   npm run debug:curate -- --to "Sundsvall, Sweden" \
 *     --interests "downhill mountain biking,nature" \
 *     --notes "we want lift-served downhill riding"
 *
 * COSTS REAL MONEY: one Claude call, plus one Places text search per distinct
 * base town and one per candidate sight. A typical run is a few cents. It is
 * a debugging tool, not something to put in a loop.
 */
import { arg, has, loadEnvFile } from './args.js'
import { generateRegionHighlights } from '../prompts/planTrip.js'
import type { RegionHighlightsResponse } from '../prompts/planTripSchema.js'
import type { TripSettings } from '@rv/shared'

/**
 * A named point without geocoding it. The curation phase only uses
 * startPoint/endPoint as prose in the prompt plus a single bias point for
 * town lookups, so a rough coordinate is enough and asking for a real
 * geocode here would just be another API call between you and the answer.
 * Override with --from-lat/--from-lng when the default bias is too far from
 * the trip to disambiguate town names.
 */
function point(name: string, lat: number, lng: number) {
  return { name, lat, lng }
}

function buildSettings(): TripSettings {
  return {
    startDate: arg('start-date', '2026-07-10'),
    endDate: arg('end-date', '2026-07-17'),
    startPoint: point(
      arg('from', 'Helsingborg, Sweden'),
      Number(arg('from-lat', '56.0465')),
      Number(arg('from-lng', '12.6945')),
    ),
    endPoint: point(
      arg('to', 'Sundsvall, Sweden'),
      Number(arg('to-lat', '62.3908')),
      Number(arg('to-lng', '17.3069')),
    ),
    travelers: [
      { name: 'Adult', role: 'adult' },
      { name: 'Child', role: 'child', age: Number(arg('child-age', '10')) },
    ],
    interests: arg('interests', 'nature,hiking')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean),
    preferredCountries: arg('countries', 'SE')
      .split(',')
      .map((value) => value.trim().toUpperCase())
      .filter(Boolean),
    restDayFrequency: Number(arg('rest-day-frequency', '4')),
    maxDriveHoursPerDay: Number(arg('max-drive-hours', '4')),
    vehicle: { type: 'RV', weightKg: 3500, registeredAs: 'car' },
  }
}

/**
 * Located or not is the single most useful column here, because it is
 * exactly the fork the tool was built to resolve: a candidate with no
 * coordinates was proposed by Claude and then rejected by Places
 * verification, and one that never appears at all was never proposed. The
 * reason for each rejection is already logged by locateCandidateSight, above
 * this report.
 */
function report(highlights: RegionHighlightsResponse): void {
  let total = 0
  let located = 0
  for (const region of highlights.regions) {
    console.log(`\n## ${region.region} (${region.country})`)
    console.log(`   ${region.reasoning}`)
    for (const stop of region.candidateStops) {
      total++
      const pinned = stop.lat != null && stop.lng != null
      if (pinned) located++
      console.log(
        `   ${pinned ? '📍' : '❌'} [${stop.priority}] ${stop.sight}` +
          `\n      base town: ${stop.town}, ${stop.country}` +
          `\n      interest:  ${stop.interest ?? '(none given)'}` +
          `\n      time:      ${stop.timeNeeded ?? '(none given)'}`,
      )
    }
  }
  console.log(
    `\n${total} candidate(s), ${located} located, ${total - located} proposed but not found by Places.`,
  )
  if (total === 0) {
    console.log(
      'Nothing was proposed at all — that is a curation problem (the prompt, the\n' +
        'interests, or the corridor), not a verification one.',
    )
  }
}

async function main(): Promise<void> {
  loadEnvFile(arg('env-file', '.env.debug.local'))
  if (!process.env.CLAUDE_API_KEY) {
    console.error(
      'CLAUDE_API_KEY is not set. Put it in .env.debug.local (gitignored) or\n' +
        'export it, then run again. GOOGLE_PLACES_API_KEY too, or every\n' +
        'candidate will come back unlocated and the report will be misleading.',
    )
    process.exitCode = 1
    return
  }

  const settings = buildSettings()
  const notes = arg('notes', '')
  console.log('Curating with:')
  console.log(`  ${settings.startPoint.name} → ${settings.endPoint.name}`)
  console.log(`  interests: ${settings.interests.join(', ') || '(none)'}`)
  console.log(`  notes:     ${notes || '(none)'}`)

  const highlights = await generateRegionHighlights({
    settings,
    notesFreeText: notes,
  })

  if (has('json')) {
    console.log(JSON.stringify(highlights, null, 2))
    return
  }
  report(highlights)
}

await main()
