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

// runRescanCorridor delegates all Claude/Places work to
// generateRescanCandidates — mocked here (same approach
// overnightCandidatesCallable.test.ts uses) so the write-path orchestration
// (proposed status, no linkedDayIds, notesFreeText passed through) is
// verified deterministically against the real Firestore emulator.
const generateRescanCandidatesMock = vi.fn()
vi.mock('./prompts/rescanCorridor.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./prompts/rescanCorridor.js')>()
  return {
    ...actual,
    generateRescanCandidates: (...args: unknown[]) =>
      generateRescanCandidatesMock(...args),
  }
})

const CENTER = { lat: 61.77, lng: 9.54 }

describe('runRescanCorridor', () => {
  it('writes each find as a proposed, unlinked corridor stop, on an already-generated trip', async () => {
    const { tripId } = await createTripForUser('uidRescanA')
    // A fresh trip starts 'idle' (see the explore-mode test below) — this
    // test is specifically about the post-generation rescan path, so it
    // needs a trip that already has a plan.
    await getFirestore()
      .collection('trips')
      .doc(tripId)
      .update({ 'planMeta.status': 'ready' })
    generateRescanCandidatesMock.mockReset().mockResolvedValue([
      { name: 'Otta Café', country: 'NO', why: 'A local favourite.', lat: 61.78, lng: 9.55 },
      { name: 'Rondane viewpoint', country: 'NO', why: 'Sweeping views.', lat: 61.85, lng: 9.85 },
    ])

    const { runRescanCorridor } = await import('./rescanCorridorCallable.js')
    const count = await runRescanCorridor(tripId, CENTER, 25)

    expect(count).toBe(2)

    const snap = await getFirestore()
      .collection('trips')
      .doc(tripId)
      .collection('corridorStops')
      .get()
    const stops = snap.docs.map((d) => d.data() as CorridorStop)
    expect(stops.map((s) => s.name).sort()).toEqual([
      'Otta Café',
      'Rondane viewpoint',
    ])
    for (const stop of stops) {
      expect(stop.status).toBe('proposed')
      expect(stop.linkedDayIds).toEqual([])
      expect(stop.priority).toBeUndefined()
    }
  })

  it('writes each find as an explore-mode candidate on a trip with no plan yet', async () => {
    const { tripId } = await createTripForUser('uidRescanExplore')
    generateRescanCandidatesMock.mockReset().mockResolvedValue([
      { name: 'Otta Café', country: 'NO', why: 'A local favourite.', lat: 61.78, lng: 9.55 },
      { name: 'Rondane viewpoint', country: 'NO', why: 'Sweeping views.', lat: 61.85, lng: 9.85 },
    ])

    const { runRescanCorridor } = await import('./rescanCorridorCallable.js')
    const count = await runRescanCorridor(tripId, CENTER, 25)

    expect(count).toBe(2)

    const snap = await getFirestore()
      .collection('trips')
      .doc(tripId)
      .collection('corridorStops')
      .orderBy('rank')
      .get()
    const stops = snap.docs.map((d) => d.data() as CorridorStop)
    expect(stops).toHaveLength(2)
    for (const stop of stops) {
      expect(stop.status).toBe('candidate')
      expect(stop.priority).toBe('worth-a-detour')
      expect(stop.linkedDayIds).toEqual([])
    }
    expect(stops.map((s) => s.rank)).toEqual([0, 1])
  })

  it('ranks explore-mode finds after any existing worth-a-detour candidates', async () => {
    const { tripId } = await createTripForUser('uidRescanExploreAppend')
    await getFirestore()
      .collection('trips')
      .doc(tripId)
      .collection('corridorStops')
      .add({
        name: 'Existing candidate',
        lat: 60,
        lng: 10,
        country: 'NO',
        status: 'candidate',
        linkedDayIds: [],
        priority: 'worth-a-detour',
        rank: 0,
      })
    generateRescanCandidatesMock.mockReset().mockResolvedValue([
      { name: 'New find', country: 'NO', why: 'Nice.', lat: 61.78, lng: 9.55 },
    ])

    const { runRescanCorridor } = await import('./rescanCorridorCallable.js')
    await runRescanCorridor(tripId, CENTER, 25)

    const snap = await getFirestore()
      .collection('trips')
      .doc(tripId)
      .collection('corridorStops')
      .where('name', '==', 'New find')
      .get()
    expect(snap.docs[0]?.data().rank).toBe(1)
  })

  it('passes the center, radius, and trip notes through to the generator', async () => {
    const { tripId } = await createTripForUser('uidRescanB')
    await getFirestore().collection('trips').doc(tripId).update({
      'notes.freeText': 'We like hands-on museums.',
    })
    generateRescanCandidatesMock.mockReset().mockResolvedValue([])

    const { runRescanCorridor } = await import('./rescanCorridorCallable.js')
    await runRescanCorridor(tripId, CENTER, 15)

    expect(generateRescanCandidatesMock).toHaveBeenCalledWith({
      center: CENTER,
      radiusKm: 15,
      notesFreeText: 'We like hands-on museums.',
      tripId,
    })
  })

  // "Describe what you want" (AddCorridorStopForm, 2026-08-01).
  it('passes a query through to the generator when one is given', async () => {
    const { tripId } = await createTripForUser('uidRescanQuery')
    generateRescanCandidatesMock.mockReset().mockResolvedValue([])

    const { runRescanCorridor } = await import('./rescanCorridorCallable.js')
    await runRescanCorridor(tripId, CENTER, 15, 'coffee stop')

    expect(generateRescanCandidatesMock).toHaveBeenCalledWith(
      expect.objectContaining({ query: 'coffee stop' }),
    )
  })

  // Route-aware search (2026-08-01) — see rescanCorridor.test.ts for the
  // actual detour-filtering behavior this backbone enables.
  it('passes the route backbone through to the generator when one is given', async () => {
    const { tripId } = await createTripForUser('uidRescanBackbone')
    generateRescanCandidatesMock.mockReset().mockResolvedValue([])
    const backbone = [
      { lat: 61.0, lng: 9.0 },
      { lat: 62.0, lng: 9.0 },
    ]

    const { runRescanCorridor } = await import('./rescanCorridorCallable.js')
    await runRescanCorridor(tripId, CENTER, 15, 'coffee stop', backbone)

    expect(generateRescanCandidatesMock).toHaveBeenCalledWith(
      expect.objectContaining({ backbone }),
    )
  })

  it('writes nothing when the search finds nothing', async () => {
    const { tripId } = await createTripForUser('uidRescanC')
    generateRescanCandidatesMock.mockReset().mockResolvedValue([])

    const { runRescanCorridor } = await import('./rescanCorridorCallable.js')
    const count = await runRescanCorridor(tripId, CENTER, 25)

    expect(count).toBe(0)
    const snap = await getFirestore()
      .collection('trips')
      .doc(tripId)
      .collection('corridorStops')
      .get()
    expect(snap.empty).toBe(true)
  })

  it('throws not-found for a trip that does not exist', async () => {
    const { runRescanCorridor } = await import('./rescanCorridorCallable.js')
    await expect(
      runRescanCorridor('nonexistent-trip', CENTER, 25),
    ).rejects.toThrow()
  })
})

describe('rescanCorridor callable', () => {
  it('rejects a signed-in caller who is not a member of the trip', async () => {
    const { tripId } = await createTripForUser('uidRescanCallableOwner')
    generateRescanCandidatesMock.mockReset().mockResolvedValue([])
    const { rescanCorridor } = await import('./rescanCorridorCallable.js')
    await expect(
      rescanCorridor.run({
        data: { tripId, center: CENTER, radiusKm: 25 },
        auth: { uid: 'uidRescanCallableStranger' },
      } as never),
    ).rejects.toThrow('Not a member of this trip')
    expect(generateRescanCandidatesMock).not.toHaveBeenCalled()
  })
})
