import { getFirestore } from 'firebase-admin/firestore'
import { initializeApp } from 'firebase-admin/app'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { createTripForUser } from './trips.js'
import type { Trip } from '@rv/shared'

const PROJECT_ID = 'demo-rv-trip-planner'

beforeAll(() => {
  initializeApp({ projectId: PROJECT_ID })
  getFirestore().settings({ ignoreUndefinedProperties: true })
})

// The opt-in "search the web for more stops" pass (implemented 2026-07-28)
// is exercised through pauseForHighlightsReview directly, the same way
// generatePlan.reviewPause.test.ts does — the Functions emulator runs the
// compiled bundle in its own process, so vi.mock can't reach the real
// trigger. Only the two outside services are mocked (Claude and Places,
// neither of which has real credentials here, matching every other
// Claude/Places-touching test in this codebase); the enrichment module
// itself — its merge, its geocoding pass, and its distance filter — runs for
// real.
const generateRegionHighlightsMock = vi.fn()
vi.mock('./prompts/planTrip.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./prompts/planTrip.js')>()
  return {
    ...actual,
    generateRegionHighlights: (...args: unknown[]) =>
      generateRegionHighlightsMock(...args),
  }
})

const createMock = vi.fn()
vi.mock('@anthropic-ai/sdk', () => ({
  default: class {
    messages = { create: createMock }
  },
}))

const geocodeQueryMock = vi.fn()
vi.mock('./placesApi.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./placesApi.js')>()
  return {
    ...actual,
    geocodeQuery: (...args: unknown[]) => geocodeQueryMock(...args),
  }
})

// Meridian corridor with hand-checkable geometry: start (50,10) → the
// curated must-see (52,10) → finish (54,10).
const MERIDIAN_ENDPOINTS = {
  'settings.startPoint': { name: 'South end', lat: 50, lng: 10 },
  'settings.endPoint': { name: 'North end', lat: 54, lng: 10 },
}

const CURATED_HIGHLIGHTS = {
  regions: [
    {
      region: 'Meridian country',
      country: 'NO',
      reasoning: 'The corridor the trip is already built around.',
      candidateStops: [
        {
          town: 'Midpoint',
          country: 'NO',
          why: 'The anchor of the trip.',
          priority: 'must-see',
          lat: 52,
          lng: 10,
        },
      ],
    },
  ],
}

function searchResponse(towns: string[]) {
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify({
          regions: [
            {
              region: 'Web finds',
              country: 'NO',
              reasoning: 'Recently opened places the first pass missed.',
              candidateStops: towns.map((town) => ({
                town,
                country: 'NO',
                why: `Why ${town}.`,
                priority: 'worth-a-detour',
              })),
            },
          ],
        }),
      },
    ],
  }
}

async function preparedTrip(uid: string) {
  const db = getFirestore()
  const { tripId } = await createTripForUser(uid)
  const tripRef = db.collection('trips').doc(tripId)
  await tripRef.update(MERIDIAN_ENDPOINTS)
  const snap = await tripRef.get()
  return { tripRef, trip: snap.data() as Trip }
}

async function pendingHighlights(
  tripRef: FirebaseFirestore.DocumentReference,
): Promise<{ regions: { region: string; candidateStops: unknown[] }[] }> {
  const snap = await tripRef.get()
  return snap.data()?.planMeta.pendingHighlights
}

describe('pauseForHighlightsReview with searchForMoreStops', () => {
  it('merges web-search finds into the review list, tagged as search-sourced', async () => {
    const { tripRef, trip } = await preparedTrip('uidEnrichA')
    generateRegionHighlightsMock.mockReset().mockResolvedValue(CURATED_HIGHLIGHTS)
    createMock.mockReset().mockResolvedValueOnce(searchResponse(['Nearby']))
    // ~40 km of extra driving — well inside MAX_ENRICHMENT_DETOUR_KM.
    geocodeQueryMock.mockReset().mockResolvedValue({ lat: 51, lng: 11 })

    const { pauseForHighlightsReview } = await import('./generatePlan.js')
    await pauseForHighlightsReview(trip, tripRef, true)

    const snap = await tripRef.get()
    expect(snap.data()?.planMeta.status).toBe('awaiting-highlights-review')

    const highlights = await pendingHighlights(tripRef)
    // Appended as its own region — the curated one is untouched.
    expect(highlights.regions.map((r) => r.region)).toEqual([
      'Meridian country',
      'Web finds',
    ])
    expect(highlights.regions[1].candidateStops).toEqual([
      expect.objectContaining({
        town: 'Nearby',
        source: 'search',
        lat: 51,
        lng: 11,
      }),
    ])
    // Curated candidates are not retro-labelled — absent means curated.
    expect(highlights.regions[0].candidateStops[0]).not.toHaveProperty('source')
  })

  it('leaves the highlights untouched and makes no extra call when the flag is off', async () => {
    const { tripRef, trip } = await preparedTrip('uidEnrichB')
    generateRegionHighlightsMock.mockReset().mockResolvedValue(CURATED_HIGHLIGHTS)
    createMock.mockReset()
    geocodeQueryMock.mockReset()

    const { pauseForHighlightsReview } = await import('./generatePlan.js')
    await pauseForHighlightsReview(trip, tripRef)

    expect(await pendingHighlights(tripRef)).toEqual(CURATED_HIGHLIGHTS)
    expect(createMock).not.toHaveBeenCalled()
  })

  it('drops a find that sits too far off the route', async () => {
    const { tripRef, trip } = await preparedTrip('uidEnrichC')
    generateRegionHighlightsMock.mockReset().mockResolvedValue(CURATED_HIGHLIGHTS)
    createMock
      .mockReset()
      .mockResolvedValueOnce(searchResponse(['Nearby', 'Far Away']))
    geocodeQueryMock
      .mockReset()
      .mockImplementation((query: string) =>
        Promise.resolve(
          // Three degrees east of the corridor: ~250 km of extra driving,
          // which is a different trip, not a detour.
          query.startsWith('Far Away')
            ? { lat: 51, lng: 13 }
            : { lat: 51, lng: 11 },
        ),
      )

    const { pauseForHighlightsReview } = await import('./generatePlan.js')
    await pauseForHighlightsReview(trip, tripRef, true)

    const highlights = await pendingHighlights(tripRef)
    expect(
      (highlights.regions[1].candidateStops as { town: string }[]).map(
        (stop) => stop.town,
      ),
    ).toEqual(['Nearby'])
  })

  it('still pauses for review on the curated highlights when the enrichment call fails', async () => {
    const { tripRef, trip } = await preparedTrip('uidEnrichD')
    generateRegionHighlightsMock.mockReset().mockResolvedValue(CURATED_HIGHLIGHTS)
    createMock.mockReset().mockRejectedValue(new Error('web search exploded'))
    geocodeQueryMock.mockReset()

    const { pauseForHighlightsReview } = await import('./generatePlan.js')
    await expect(
      pauseForHighlightsReview(trip, tripRef, true),
    ).resolves.toBeUndefined()

    const snap = await tripRef.get()
    expect(snap.data()?.planMeta.status).toBe('awaiting-highlights-review')
    expect(snap.data()?.planMeta.pendingHighlights).toEqual(CURATED_HIGHLIGHTS)
  })
})
