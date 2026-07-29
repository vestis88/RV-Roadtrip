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
  it('writes each find as a proposed, unlinked corridor stop', async () => {
    const { tripId } = await createTripForUser('uidRescanA')
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
    }
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
    })
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
