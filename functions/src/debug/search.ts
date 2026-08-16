/**
 * Runs the real "Rescan this area" search and prints what happened —
 * including, especially, the exception.
 *
 * Written after three consecutive rescan failures were each reported as the
 * same sentence on a phone ("Could not rescan this area right now") with the
 * actual cause never leaving the server. firebase-functions forwards only an
 * HttpsError's message, so everything else arrived as the bare code
 * 'internal'; the callable now says what broke, but a message on a phone is
 * still a slow way to ask a question, and the first two fixes for those
 * failures were guesses made without ever seeing one.
 *
 * This calls generateRescanCandidates directly — same prompt, same model,
 * same web_search tool, same geocoding as production — with no Firestore, no
 * trip, no emulator and nothing written anywhere. It reports how long the
 * search took, which matters here: the failure being chased is a timeout,
 * and wall time is the measurement that distinguishes "too slow" from
 * "broken".
 *
 * Usage:
 *   cp .env.debug.local.example .env.debug.local   # then put real keys in it
 *   npm run debug:search -- --lat 56.51 --lng 13.04 --radius 25
 *   npm run debug:search -- --lat 56.51 --lng 13.04 --query "downhill bike park"
 *
 * COSTS REAL MONEY: one Claude call with up to three web searches, plus one
 * Places geocode per find.
 */
import { arg, loadEnvFile } from './args.js'
import { generateRescanCandidates } from '../prompts/rescanCorridor.js'

function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`
}

async function main(): Promise<void> {
  loadEnvFile(arg('env-file', '.env.debug.local'))
  if (!process.env.CLAUDE_API_KEY) {
    console.error(
      'CLAUDE_API_KEY is not set. Put it in .env.debug.local (gitignored) or\n' +
        'export it, then run again. GOOGLE_PLACES_API_KEY too, or every find\n' +
        'will fail to geocode and the run will look emptier than it was.',
    )
    process.exitCode = 1
    return
  }

  const center = {
    lat: Number(arg('lat', '56.5106')),
    lng: Number(arg('lng', '13.0402')),
  }
  const radiusKm = Number(arg('radius', '25'))
  const query = arg('query', '')
  const notes = arg('notes', '')

  console.log('Searching:')
  console.log(`  centre:  ${center.lat}, ${center.lng} (${radiusKm} km)`)
  console.log(`  query:   ${query || '(none — the general "what is worth stopping for" pass)'}`)
  console.log(`  notes:   ${notes || '(none)'}`)

  const startedAt = Date.now()
  try {
    const finds = await generateRescanCandidates({
      center,
      radiusKm,
      ...(query ? { query } : {}),
      ...(notes ? { notesFreeText: notes } : {}),
      centerName: arg('center-name', ''),
    })
    console.log(`\nFinished in ${seconds(Date.now() - startedAt)}.`)
    if (finds.length === 0) {
      console.log(
        'No finds survived. Either the search genuinely found nothing here, or\n' +
          'every find was dropped for being outside the radius — the per-find\n' +
          'reasons are logged above this line.',
      )
      return
    }
    for (const find of finds) {
      console.log(`  📍 ${find.name} (${find.country}) — ${find.lat}, ${find.lng}`)
      console.log(`     ${find.why}`)
    }
  } catch (error) {
    // The whole reason this file exists. A rescan that fails in the app tells
    // the traveler one sentence; here the real exception is the output.
    console.error(`\nFailed after ${seconds(Date.now() - startedAt)}:`)
    console.error(error)
    process.exitCode = 1
  }
}

await main()
