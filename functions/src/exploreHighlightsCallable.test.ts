import { getFirestore } from 'firebase-admin/firestore'
import { initializeApp } from 'firebase-admin/app'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { createTripForUser } from './trips.js'
import type { CorridorStop } from '@rv/shared'

const PROJECT_ID = 'demo-rv-trip-planner'

beforeAll(() => {
  initializeApp({ projectId: PROJECT_ID })
  getFirestore().settings({ ignoreUndefinedProperties: true })
})

const generateRegionHighlightsMock = vi.fn()
vi.mock('./prompts/planTrip.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./prompts/planTrip.js')>()
  return {
    ...actual,
    generateRegionHighlights: (...args: unknown[]) =>
      generateRegionHighlightsMock(...args),
  }
})

const FIXTURE_HIGHLIGHTS = {
  regions: [
    {
      region: 'Gudbrandsdalen',
      country: 'NO',
      reasoning: 'r',
      candidateStops: [
        {
          sight: 'Otta Church',
          town: 'Otta',
          country: 'NO',
          why: 'w',
          priority: 'must-see' as const,
          interest: 'hiking',
          timeNeeded: 'couple-of-hours' as const,
          lat: 61.77,
          lng: 9.54,
        },
      ],
    },
  ],
}

describe('generateExploreHighlightsForTrip', () => {
  it('writes candidate corridor stops from the highlights response', async () => {
    const db = getFirestore()
    const { tripId } = await createTripForUser('uidExploreGenA')
    generateRegionHighlightsMock.mockReset().mockResolvedValue(FIXTURE_HIGHLIGHTS)

    const { generateExploreHighlightsForTrip } = await import(
      './exploreHighlightsCallable.js'
    )
    const result = await generateExploreHighlightsForTrip(tripId)

    expect(result.candidateCount).toBe(1)
    const snap = await db.collection('trips').doc(tripId).collection('corridorStops').get()
    const stops = snap.docs.map((d) => d.data() as CorridorStop)
    expect(stops).toHaveLength(1)
    expect(stops[0]).toMatchObject({
      name: 'Otta Church',
      baseTown: 'Otta',
      interest: 'hiking',
      timeNeeded: 'couple-of-hours',
      status: 'candidate',
      priority: 'must-see',
      region: 'Gudbrandsdalen',
      rank: 0,
    })
  })

  // Regression: "Generate overview" (Trip Setup) navigates to /map on
  // success, mounting ExploreMapScreen fresh with no memory of the search
  // that just ran — so a genuinely empty result (a short/local trip
  // legitimately having nothing to flag) looked identical to "never
  // searched," even right after the button visibly completed.
  it('sets planMeta.exploreLastRunAt on a completed run, even with zero candidates', async () => {
    const db = getFirestore()
    const { tripId } = await createTripForUser('uidExploreGenEmpty')
    generateRegionHighlightsMock.mockReset().mockResolvedValue({ regions: [] })

    const { generateExploreHighlightsForTrip } = await import(
      './exploreHighlightsCallable.js'
    )
    const result = await generateExploreHighlightsForTrip(tripId)

    expect(result.candidateCount).toBe(0)
    const snap = await db.collection('trips').doc(tripId).get()
    expect(snap.data()?.planMeta?.exploreLastRunAt).toBeTruthy()
  })

  // The safety net behind the missing-secret bug above: if Claude proposes
  // real towns and NONE survive to a write, every geocode failed — a
  // systemic fault (bad key, quota, outage), not the per-candidate
  // best-effort degradation the drop exists for. Silently returning 0 is
  // the worst outcome: the traveler sees "nothing found" on a route full
  // of real stops, and the Claude call is already paid for.
  it('errors instead of reporting an empty success when every candidate fails to geocode', async () => {
    const db = getFirestore()
    const { tripId } = await createTripForUser('uidExploreGenAllDropped')
    // Candidates with no lat/lng — exactly what geocodeHighlights returns
    // when geocodeQuery throws for each one.
    generateRegionHighlightsMock.mockReset().mockResolvedValue({
      regions: [
        {
          region: 'Öresund',
          country: 'SE',
          reasoning: 'r',
          candidateStops: [
            { sight: 'Kärnan', town: 'Helsingborg', country: 'SE', why: 'w', priority: 'must-see' as const },
            { sight: 'Turning Torso', town: 'Malmö', country: 'SE', why: 'w', priority: 'must-see' as const },
          ],
        },
      ],
    })

    const { generateExploreHighlightsForTrip } = await import(
      './exploreHighlightsCallable.js'
    )
    await expect(generateExploreHighlightsForTrip(tripId)).rejects.toThrow(
      'could not locate any of them',
    )

    const snap = await db.collection('trips').doc(tripId).get()
    // Neither half-applied nor recorded as a genuine "searched, found nothing".
    expect(snap.data()?.planMeta?.exploreLastRunAt).toBeUndefined()
    expect(snap.data()?.planMeta?.exploreStatus).toBe('idle')
    const stops = await db
      .collection('trips')
      .doc(tripId)
      .collection('corridorStops')
      .get()
    expect(stops.empty).toBe(true)
  })

  // The honest-empty case must still be allowed through — Claude proposing
  // nothing at all is a valid answer for a short/local trip, and must not
  // be conflated with the total-geocode-failure case above.
  it('does not error when Claude itself proposed nothing', async () => {
    const { tripId } = await createTripForUser('uidExploreGenHonestEmpty')
    generateRegionHighlightsMock.mockReset().mockResolvedValue({ regions: [] })

    const { generateExploreHighlightsForTrip } = await import(
      './exploreHighlightsCallable.js'
    )
    await expect(generateExploreHighlightsForTrip(tripId)).resolves.toEqual({
      candidateCount: 0,
      alreadyKnown: 0,
      // No preferred countries on this trip, so nothing to report empty.
      emptyCountries: [],
    })
  })

  // Reported 2026-08-13: pressing "Generate overview" mid-trip wiped out
  // weeks of curation. A refresh used to delete every candidate stop before
  // writing its own pass, which was harmless only while candidates were
  // consumed at generation — they are durable now, and every interest level
  // the traveler had set went with them.
  it('keeps existing candidates, and the interest levels set on them, through a refresh', async () => {
    const db = getFirestore()
    const { tripId } = await createTripForUser('uidExploreGenMerge')
    const stops = db.collection('trips').doc(tripId).collection('corridorStops')
    const curated = await stops.add({
      name: 'Jotunheimen National Park',
      lat: 61.5,
      lng: 8.3,
      country: 'NO',
      status: 'candidate',
      linkedDayIds: [],
      // Claude called it worth-a-detour; the traveler disagreed.
      priority: 'must-see',
      region: 'Gudbrandsdalen',
      rank: 0,
    })
    generateRegionHighlightsMock.mockReset().mockResolvedValue(FIXTURE_HIGHLIGHTS)

    const { generateExploreHighlightsForTrip } = await import(
      './exploreHighlightsCallable.js'
    )
    const result = await generateExploreHighlightsForTrip(tripId)

    expect(result).toEqual({
      candidateCount: 1,
      alreadyKnown: 0,
      emptyCountries: [],
    })
    const after = await curated.get()
    expect(after.exists).toBe(true)
    expect(after.data()?.priority).toBe('must-see')
    expect((await stops.get()).size).toBe(2)
  })

  it('does not propose a sight the traveler already rejected, and reports it as already known', async () => {
    const db = getFirestore()
    const { tripId } = await createTripForUser('uidExploreGenNoResurrect')
    const stops = db.collection('trips').doc(tripId).collection('corridorStops')
    await stops.add({
      name: 'Otta Church',
      lat: 61.77,
      lng: 9.54,
      country: 'NO',
      status: 'rejected',
      linkedDayIds: [],
      priority: 'must-see',
    })
    generateRegionHighlightsMock.mockReset().mockResolvedValue(FIXTURE_HIGHLIGHTS)

    const { generateExploreHighlightsForTrip } = await import(
      './exploreHighlightsCallable.js'
    )
    const result = await generateExploreHighlightsForTrip(tripId)

    expect(result).toEqual({
      candidateCount: 0,
      alreadyKnown: 1,
      emptyCountries: [],
    })
    const after = await stops.get()
    expect(after.size).toBe(1)
    expect(after.docs[0].data().status).toBe('rejected')
  })

  // A run that finds only what the traveler already has writes nothing —
  // which is a healthy result, not the total-lookup-failure the guard above
  // is for. Before the merge those two were the same observation.
  it('does not mistake "you already have all of these" for a lookup outage', async () => {
    const db = getFirestore()
    const { tripId } = await createTripForUser('uidExploreGenAllKnown')
    await db
      .collection('trips')
      .doc(tripId)
      .collection('corridorStops')
      .add({
        name: 'Otta Church',
        lat: 61.77,
        lng: 9.54,
        country: 'NO',
        status: 'candidate',
        linkedDayIds: [],
        priority: 'must-see',
      })
    generateRegionHighlightsMock.mockReset().mockResolvedValue(FIXTURE_HIGHLIGHTS)

    const { generateExploreHighlightsForTrip } = await import(
      './exploreHighlightsCallable.js'
    )
    await expect(generateExploreHighlightsForTrip(tripId)).resolves.toEqual({
      candidateCount: 0,
      alreadyKnown: 1,
      emptyCountries: [],
    })
    const snap = await db.collection('trips').doc(tripId).get()
    expect(snap.data()?.planMeta?.exploreLastRunAt).toBeTruthy()
  })

  it('does not set planMeta.exploreLastRunAt when the run fails', async () => {
    const db = getFirestore()
    const { tripId } = await createTripForUser('uidExploreGenFailNoMark')
    generateRegionHighlightsMock.mockReset().mockRejectedValue(new Error('boom'))

    const { generateExploreHighlightsForTrip } = await import(
      './exploreHighlightsCallable.js'
    )
    await expect(generateExploreHighlightsForTrip(tripId)).rejects.toThrow('boom')

    const snap = await db.collection('trips').doc(tripId).get()
    expect(snap.data()?.planMeta?.exploreLastRunAt).toBeUndefined()
  })

  // Regression for 2026-08-12: Claude returned unparseable JSON on both
  // attempts, generateRegionHighlights threw a plain Error, and
  // firebase-functions handed the browser the bare code 'internal' with the
  // message "INTERNAL" — so the screen could only offer "please try again",
  // which for a deterministic fault is advice that cannot work and costs two
  // more Claude calls every time it is followed.
  it('reports the underlying cause instead of an opaque internal error', async () => {
    const { tripId } = await createTripForUser('uidExploreGenCause')
    generateRegionHighlightsMock
      .mockReset()
      .mockRejectedValue(
        new Error('SyntaxError: Unexpected token \'}\' ... is not valid JSON'),
      )

    const { generateExploreHighlightsForTrip } = await import(
      './exploreHighlightsCallable.js'
    )
    await expect(generateExploreHighlightsForTrip(tripId)).rejects.toMatchObject({
      code: 'internal',
      message: expect.stringContaining('is not valid JSON'),
    })
  })

  // The messages this file writes for the traveler ("hang tight", "could not
  // locate any of them on the map") must reach them verbatim rather than
  // being re-wrapped as a generic cause.
  it('passes its own HttpsErrors through untouched', async () => {
    const db = getFirestore()
    const { tripId } = await createTripForUser('uidExploreGenPassThrough')
    generateRegionHighlightsMock.mockReset().mockResolvedValue(FIXTURE_HIGHLIGHTS)
    await db.collection('trips').doc(tripId).update({
      'planMeta.exploreStatus': 'generating',
      'planMeta.exploreStatusUpdatedAt': new Date().toISOString(),
    })

    const { generateExploreHighlightsForTrip } = await import(
      './exploreHighlightsCallable.js'
    )
    await expect(generateExploreHighlightsForTrip(tripId)).rejects.toMatchObject({
      code: 'failed-precondition',
      message: 'Already finding great stops for this trip — hang tight.',
    })
  })

  // Reported 2026-08-17: "Could not find stops right now — please try again"
  // on a trip already back at idle, with nothing anywhere saying what had
  // gone wrong. The cause existed only in the promise the phone had stopped
  // following. The rescan path has recorded its failures since 2026-08-16;
  // this is the same record for the search that runs far more often.
  it('records why the run failed, where it outlives the request', async () => {
    const db = getFirestore()
    const { tripId } = await createTripForUser('uidExploreGenDurableError')
    generateRegionHighlightsMock
      .mockReset()
      .mockRejectedValue(new Error('Places lookup refused: REQUEST_DENIED'))

    const { generateExploreHighlightsForTrip } = await import(
      './exploreHighlightsCallable.js'
    )
    await expect(generateExploreHighlightsForTrip(tripId)).rejects.toThrow(
      'REQUEST_DENIED',
    )

    const meta = (await db.collection('trips').doc(tripId).get()).data()?.planMeta
    expect(meta?.exploreLastError).toContain('REQUEST_DENIED')
    expect(meta?.exploreLastFailedAt).toBeTruthy()
  })

  // The stored sentence and the rejected one must be the same string, so a
  // phone reading the failure off the trip and a phone reading it off the
  // rejection are not shown two paraphrases of one fault.
  it('stores exactly the message the caller would have been told', async () => {
    const db = getFirestore()
    const { tripId } = await createTripForUser('uidExploreGenSameWords')
    generateRegionHighlightsMock
      .mockReset()
      .mockRejectedValue(new Error('no JSON in the response'))

    const { generateExploreHighlightsForTrip } = await import(
      './exploreHighlightsCallable.js'
    )
    let thrown = ''
    try {
      await generateExploreHighlightsForTrip(tripId)
    } catch (error) {
      thrown = (error as { message: string }).message
    }

    const meta = (await db.collection('trips').doc(tripId).get()).data()?.planMeta
    expect(thrown).toContain('no JSON in the response')
    expect(meta?.exploreLastError).toBe(thrown)
  })

  it('clears a recorded failure once a run succeeds', async () => {
    const db = getFirestore()
    const { tripId } = await createTripForUser('uidExploreGenClearsError')
    await db.collection('trips').doc(tripId).update({
      'planMeta.exploreLastError': 'Could not find stops: an old problem',
      'planMeta.exploreLastFailedAt': new Date().toISOString(),
    })
    generateRegionHighlightsMock.mockReset().mockResolvedValue(FIXTURE_HIGHLIGHTS)

    const { generateExploreHighlightsForTrip } = await import(
      './exploreHighlightsCallable.js'
    )
    await generateExploreHighlightsForTrip(tripId)

    const meta = (await db.collection('trips').doc(tripId).get()).data()?.planMeta
    expect(meta?.exploreLastError).toBeUndefined()
    expect(meta?.exploreLastFailedAt).toBeUndefined()
  })

  // A run rejected by the busy guard has not failed — it never started, and
  // the run it collided with may still be perfectly healthy. Recording it
  // would overwrite the real last failure with a message about a button
  // press.
  it('does not record the busy guard as a failure of the trip', async () => {
    const db = getFirestore()
    const { tripId } = await createTripForUser('uidExploreGenBusyNoRecord')
    generateRegionHighlightsMock.mockReset().mockResolvedValue(FIXTURE_HIGHLIGHTS)
    await db.collection('trips').doc(tripId).update({
      'planMeta.exploreStatus': 'generating',
      'planMeta.exploreStatusUpdatedAt': new Date().toISOString(),
    })

    const { generateExploreHighlightsForTrip } = await import(
      './exploreHighlightsCallable.js'
    )
    await expect(generateExploreHighlightsForTrip(tripId)).rejects.toMatchObject({
      code: 'failed-precondition',
    })

    const meta = (await db.collection('trips').doc(tripId).get()).data()?.planMeta
    expect(meta?.exploreLastError).toBeUndefined()
  })

  it('clears planMeta.exploreStatus back to idle even after a failure', async () => {
    const db = getFirestore()
    const { tripId } = await createTripForUser('uidExploreGenFail')
    generateRegionHighlightsMock.mockReset().mockRejectedValue(new Error('boom'))

    const { generateExploreHighlightsForTrip } = await import(
      './exploreHighlightsCallable.js'
    )
    await expect(generateExploreHighlightsForTrip(tripId)).rejects.toThrow('boom')

    const snap = await db.collection('trips').doc(tripId).get()
    expect(snap.data()?.planMeta?.exploreStatus).toBe('idle')
  })

  it('rejects a second concurrent call while one is already generating', async () => {
    const db = getFirestore()
    const { tripId } = await createTripForUser('uidExploreGenConcurrent')
    let resolveFirst: (value: typeof FIXTURE_HIGHLIGHTS) => void = () => {}
    generateRegionHighlightsMock.mockReset().mockImplementation(
      () => new Promise((resolve) => (resolveFirst = resolve)),
    )

    const { generateExploreHighlightsForTrip } = await import(
      './exploreHighlightsCallable.js'
    )
    const first = generateExploreHighlightsForTrip(tripId)
    // Let the transaction inside the first call actually claim the guard
    // before firing the second — otherwise both could race the read.
    await new Promise((resolve) => setTimeout(resolve, 50))

    await expect(generateExploreHighlightsForTrip(tripId)).rejects.toThrow(
      'Already finding great stops',
    )

    resolveFirst(FIXTURE_HIGHLIGHTS)
    await first

    const snap = await db.collection('trips').doc(tripId).get()
    expect(snap.data()?.planMeta?.exploreStatus).toBe('idle')
  })

  it('reclaims a lock left stuck on "generating" by a crashed prior run', async () => {
    const db = getFirestore()
    const { tripId } = await createTripForUser('uidExploreGenStaleLock')
    generateRegionHighlightsMock.mockReset().mockResolvedValue(FIXTURE_HIGHLIGHTS)

    // Simulate a previous invocation that claimed the lock and then never
    // reached its own `finally` (killed by the platform's timeout, or
    // crashed) — the lock is stuck 'generating' with an old timestamp,
    // exactly what a genuinely abandoned run looks like in Firestore.
    const staleTimestamp = new Date(Date.now() - 10 * 60 * 1000).toISOString()
    await db.collection('trips').doc(tripId).update({
      'planMeta.exploreStatus': 'generating',
      'planMeta.exploreStatusUpdatedAt': staleTimestamp,
    })

    const { generateExploreHighlightsForTrip } = await import(
      './exploreHighlightsCallable.js'
    )
    const result = await generateExploreHighlightsForTrip(tripId)

    expect(result.candidateCount).toBe(1)
    const snap = await db.collection('trips').doc(tripId).get()
    expect(snap.data()?.planMeta?.exploreStatus).toBe('idle')
  })

  it('does not reclaim a lock that is still recent', async () => {
    const db = getFirestore()
    const { tripId } = await createTripForUser('uidExploreGenFreshLock')
    generateRegionHighlightsMock.mockReset().mockResolvedValue(FIXTURE_HIGHLIGHTS)

    const recentTimestamp = new Date(Date.now() - 30 * 1000).toISOString()
    await db.collection('trips').doc(tripId).update({
      'planMeta.exploreStatus': 'generating',
      'planMeta.exploreStatusUpdatedAt': recentTimestamp,
    })

    const { generateExploreHighlightsForTrip } = await import(
      './exploreHighlightsCallable.js'
    )
    await expect(generateExploreHighlightsForTrip(tripId)).rejects.toThrow(
      'Already finding great stops',
    )
  })
})

describe('generateExploreHighlights callable', () => {
  // Regression, reported as "Generate overview yields nothing on a route
  // that obviously has things to see": this callable reaches Places only
  // transitively (generateRegionHighlights -> geocodeHighlights ->
  // geocodeQuery), so the missing secret wasn't visible from its own
  // imports. A Functions v2 secret is unreadable unless the function
  // declares it, so geocodeQuery threw for every candidate, each was
  // caught by the per-candidate best-effort handler and left without
  // coordinates, and buildExploreCandidateWrites then dropped all of them
  // — a "successful" run writing zero stops after full Claude spend.
  it('declares every secret its call chain needs, including the transitive Places one', async () => {
    const { generateExploreHighlights } = await import('./exploreHighlightsCallable.js')
    const declared = (
      generateExploreHighlights.__endpoint.secretEnvironmentVariables ?? []
    ).map((s: { key: string }) => s.key)
    expect(declared).toContain('CLAUDE_API_KEY')
    expect(declared).toContain('GOOGLE_PLACES_API_KEY')
  })

  it('rejects a signed-in caller who is not a member of the trip', async () => {
    const { tripId } = await createTripForUser('uidExploreCallableOwner')
    generateRegionHighlightsMock.mockReset().mockResolvedValue(FIXTURE_HIGHLIGHTS)
    const { generateExploreHighlights } = await import('./exploreHighlightsCallable.js')
    await expect(
      generateExploreHighlights.run({
        data: { tripId },
        auth: { uid: 'uidExploreCallableStranger', token: { access: true } },
      } as never),
    ).rejects.toThrow('Not a member of this trip')
    expect(generateRegionHighlightsMock).not.toHaveBeenCalled()
  })
})
