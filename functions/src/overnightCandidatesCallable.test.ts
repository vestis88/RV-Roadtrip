import { getFirestore } from 'firebase-admin/firestore'
import { initializeApp } from 'firebase-admin/app'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { createTripForUser } from './trips.js'
import type { TripDay } from '@rv/shared'

const PROJECT_ID = 'demo-rv-trip-planner'

beforeAll(() => {
  initializeApp({ projectId: PROJECT_ID })
  getFirestore().settings({ ignoreUndefinedProperties: true })
})

// fetchOvernightCandidates orchestrates 3 independent lookups (Places,
// Overpass, Claude) — mocked here at the module level (same approach
// replanTrip.test.ts/generatePlan.checkpoint.test.ts use) so the
// orchestration itself (near/country passed through, stellplatz's
// OSM-then-Claude fallback) is verified deterministically against the real
// Firestore emulator, without needing real Places/Claude/Overpass access.
const searchCampsiteCandidatesMock = vi.fn()
vi.mock('./placesApi.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./placesApi.js')>()
  return {
    ...actual,
    searchCampsiteCandidates: (...args: unknown[]) =>
      searchCampsiteCandidatesMock(...args),
  }
})

const searchStellplatzCandidatesMock = vi.fn()
vi.mock('./overpassApi.js', () => ({
  searchStellplatzCandidates: (...args: unknown[]) =>
    searchStellplatzCandidatesMock(...args),
}))

const generateClaudeOvernightCandidatesMock = vi.fn()
vi.mock('./prompts/overnightCandidates.js', async (importOriginal) => {
  const actual = await importOriginal<
    typeof import('./prompts/overnightCandidates.js')
  >()
  return {
    ...actual,
    generateClaudeOvernightCandidates: (...args: unknown[]) =>
      generateClaudeOvernightCandidatesMock(...args),
  }
})

function fixtureCandidate(name: string, type: 'campsite' | 'stellplatz' | 'wild') {
  return {
    name,
    type,
    lat: 61.1,
    lng: 10.5,
    country: 'NO',
    description: 'fixture',
    source: type === 'campsite' ? ('places' as const) : ('claude' as const),
  }
}

async function seedDay(tripId: string, dayId: string): Promise<void> {
  const day: TripDay = {
    index: 0,
    date: dayId,
    type: 'drive',
    overnight: { name: 'Lillehammer', lat: 61.1, lng: 10.5, country: 'NO' },
    summary: 'A day',
  }
  await getFirestore()
    .collection('trips')
    .doc(tripId)
    .collection('days')
    .doc(dayId)
    .set(day)
}

describe('fetchOvernightCandidates', () => {
  it('passes the day\'s overnight location and country to each lookup, and combines their results', async () => {
    const { tripId } = await createTripForUser('uidOvernightA')
    await seedDay(tripId, '2026-08-01')

    searchCampsiteCandidatesMock
      .mockReset()
      .mockResolvedValue([fixtureCandidate('Campsite A', 'campsite')])
    searchStellplatzCandidatesMock
      .mockReset()
      .mockResolvedValue([fixtureCandidate('Stellplatz A', 'stellplatz')])
    generateClaudeOvernightCandidatesMock
      .mockReset()
      .mockResolvedValue([fixtureCandidate('Wild spot A', 'wild')])

    const { fetchOvernightCandidates } = await import(
      './overnightCandidatesCallable.js'
    )
    const candidates = await fetchOvernightCandidates(tripId, '2026-08-01')

    expect(searchCampsiteCandidatesMock).toHaveBeenCalledWith(
      { lat: 61.1, lng: 10.5 },
      'NO',
      expect.any(Number),
    )
    expect(searchStellplatzCandidatesMock).toHaveBeenCalledWith(
      { lat: 61.1, lng: 10.5 },
      'NO',
      expect.any(Number),
    )
    // Wild camping always goes through Claude, regardless of OSM results.
    expect(generateClaudeOvernightCandidatesMock).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'wild', country: 'NO' }),
    )

    expect(candidates.map((c) => c.name)).toEqual([
      'Campsite A',
      'Stellplatz A',
      'Wild spot A',
    ])
  })

  it('falls back to Claude for stellplatz only when OSM finds nothing', async () => {
    const { tripId } = await createTripForUser('uidOvernightB')
    await seedDay(tripId, '2026-08-01')

    searchCampsiteCandidatesMock.mockReset().mockResolvedValue([])
    searchStellplatzCandidatesMock.mockReset().mockResolvedValue([]) // no OSM coverage
    generateClaudeOvernightCandidatesMock
      .mockReset()
      .mockImplementation(async (input: { kind: string }) =>
        input.kind === 'stellplatz'
          ? [fixtureCandidate('Claude stellplatz', 'stellplatz')]
          : [fixtureCandidate('Claude wild', 'wild')],
      )

    const { fetchOvernightCandidates } = await import(
      './overnightCandidatesCallable.js'
    )
    const candidates = await fetchOvernightCandidates(tripId, '2026-08-01')

    expect(generateClaudeOvernightCandidatesMock).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'stellplatz' }),
    )
    expect(candidates.some((c) => c.name === 'Claude stellplatz')).toBe(true)
  })

  it('does not call Claude for stellplatz when OSM already found candidates', async () => {
    const { tripId } = await createTripForUser('uidOvernightC')
    await seedDay(tripId, '2026-08-01')

    searchCampsiteCandidatesMock.mockReset().mockResolvedValue([])
    searchStellplatzCandidatesMock
      .mockReset()
      .mockResolvedValue([fixtureCandidate('OSM stellplatz', 'stellplatz')])
    generateClaudeOvernightCandidatesMock
      .mockReset()
      .mockResolvedValue([fixtureCandidate('Claude wild', 'wild')])

    const { fetchOvernightCandidates } = await import(
      './overnightCandidatesCallable.js'
    )
    const candidates = await fetchOvernightCandidates(tripId, '2026-08-01')

    // Only called once, for 'wild' — never asked for a stellplatz fallback.
    expect(generateClaudeOvernightCandidatesMock).toHaveBeenCalledTimes(1)
    expect(generateClaudeOvernightCandidatesMock).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'wild' }),
    )
    expect(candidates.some((c) => c.name === 'OSM stellplatz')).toBe(true)
  })

  it('degrades one failed source instead of failing the whole picker', async () => {
    const { tripId } = await createTripForUser('uidOvernightE')
    await seedDay(tripId, '2026-08-01')

    searchCampsiteCandidatesMock
      .mockReset()
      .mockResolvedValue([fixtureCandidate('Campsite A', 'campsite')])
    // Overpass has no SLA and can genuinely time out or 5xx in production —
    // this must not take the campsite/wild results (already resolved) down
    // with it.
    searchStellplatzCandidatesMock
      .mockReset()
      .mockRejectedValue(new Error('Overpass query failed with 504'))
    generateClaudeOvernightCandidatesMock
      .mockReset()
      .mockImplementation(async (input: { kind: string }) =>
        input.kind === 'stellplatz'
          ? Promise.reject(new Error('stellplatz fallback also failed'))
          : [fixtureCandidate('Wild spot A', 'wild')],
      )

    const { fetchOvernightCandidates } = await import(
      './overnightCandidatesCallable.js'
    )
    const candidates = await fetchOvernightCandidates(tripId, '2026-08-01')

    // Stellplatz contributes nothing (its OSM lookup AND Claude fallback both
    // failed), but that alone doesn't erase the sources that did succeed.
    expect(candidates.map((c) => c.name)).toEqual(['Campsite A', 'Wild spot A'])
  })

  it('throws not-found for a day that does not exist', async () => {
    const { tripId } = await createTripForUser('uidOvernightD')
    const { fetchOvernightCandidates } = await import(
      './overnightCandidatesCallable.js'
    )
    await expect(
      fetchOvernightCandidates(tripId, 'nonexistent-day'),
    ).rejects.toThrow()
  })
})

describe('getOvernightCandidates callable', () => {
  it('rejects a signed-in caller who is not a member of the trip', async () => {
    const { tripId } = await createTripForUser('uidOvernightCallableOwner')
    await seedDay(tripId, '2026-08-01')
    searchCampsiteCandidatesMock.mockReset()
    const { getOvernightCandidates } = await import('./overnightCandidatesCallable.js')
    await expect(
      getOvernightCandidates.run({
        data: { tripId, dayId: '2026-08-01' },
        auth: { uid: 'uidOvernightCallableStranger' },
      } as never),
    ).rejects.toThrow('Not a member of this trip')
    expect(searchCampsiteCandidatesMock).not.toHaveBeenCalled()
  })
})
