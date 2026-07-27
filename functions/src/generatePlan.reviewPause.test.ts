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

async function waitFor<T>(
  fn: () => Promise<T | undefined>,
  timeoutMs = 15_000,
): Promise<T> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const result = await fn()
    if (result !== undefined) return result
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  throw new Error('Timed out waiting for condition')
}

// pauseForHighlightsReview and generateRealPlan's 'fromHighlights' source
// (interactive/transparent route planning, implemented 2026-07-27) are
// tested by importing and calling them directly, the same way
// generatePlan.checkpoint.test.ts tests generateRealPlan — NOT by driving
// the real onDocumentCreated trigger, since the Functions emulator runs the
// compiled bundle in its own process and vi.mock can't reach into it. The
// trigger itself (including the cost-guard rejecting a duplicate request
// while paused) IS exercised for real below, since that path needs no
// mocking — same approach costGuards.test.ts already uses.
const generateRegionHighlightsMock = vi.fn()
const generateSkeletonFromHighlightsMock = vi.fn()
vi.mock('./prompts/planTrip.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./prompts/planTrip.js')>()
  return {
    ...actual,
    generateRegionHighlights: (...args: unknown[]) =>
      generateRegionHighlightsMock(...args),
    generateSkeletonFromHighlights: (...args: unknown[]) =>
      generateSkeletonFromHighlightsMock(...args),
  }
})

const resolveSkeletonDaysMock = vi.fn()
vi.mock('./planPipeline.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./planPipeline.js')>()
  return {
    ...actual,
    resolveSkeletonDays: (...args: unknown[]) => resolveSkeletonDaysMock(...args),
  }
})

const FIXTURE_HIGHLIGHTS = {
  regions: [
    {
      region: 'Fjord country',
      country: 'NO',
      reasoning: 'Great for families.',
      candidateStops: [
        { town: 'Lillehammer', country: 'NO', why: 'Olympic sights.', priority: 'must-see' },
      ],
    },
  ],
}

function fixtureGeneratedDay(index: number, date: string) {
  return {
    day: {
      index,
      date,
      type: 'drive' as const,
      overnight: { name: `Stop ${index}`, lat: 61, lng: 10, country: 'NO' },
      drive: {
        fromName: 'prev',
        toName: `Stop ${index}`,
        distanceKm: 100,
        durationMin: 90,
        slot: 'morning' as const,
      },
      summary: `Day ${index}`,
    },
    activities: [],
    restaurants: [],
  }
}

async function loadTrip(tripId: string): Promise<Trip> {
  const snap = await getFirestore().collection('trips').doc(tripId).get()
  return snap.data() as Trip
}

describe('pauseForHighlightsReview', () => {
  it('writes the highlights and status without generating anything yet', async () => {
    const db = getFirestore()
    const { tripId } = await createTripForUser('uidReviewA')
    const tripRef = db.collection('trips').doc(tripId)

    generateRegionHighlightsMock.mockReset().mockResolvedValue(FIXTURE_HIGHLIGHTS)

    const { pauseForHighlightsReview } = await import('./generatePlan.js')
    const trip = await loadTrip(tripId)
    await pauseForHighlightsReview(trip, tripRef)

    expect(generateRegionHighlightsMock).toHaveBeenCalledWith({
      settings: trip.settings,
      notesFreeText: trip.notes.freeText,
    })

    const tripSnap = await tripRef.get()
    expect(tripSnap.data()?.planMeta.status).toBe('awaiting-highlights-review')
    expect(tripSnap.data()?.planMeta.pendingHighlights).toEqual(
      FIXTURE_HIGHLIGHTS,
    )
    expect(generateSkeletonFromHighlightsMock).not.toHaveBeenCalled()

    const daysSnap = await tripRef.collection('days').get()
    expect(daysSnap.size).toBe(0)
  })
})

describe("generateRealPlan with source: 'fromHighlights'", () => {
  it('skips the highlights phase entirely and generates from the given highlights', async () => {
    const db = getFirestore()
    const { tripId } = await createTripForUser('uidReviewB')
    const tripRef = db.collection('trips').doc(tripId)

    const editedHighlights = {
      regions: [
        {
          ...FIXTURE_HIGHLIGHTS.regions[0],
          candidateStops: [
            {
              ...FIXTURE_HIGHLIGHTS.regions[0].candidateStops[0],
              priority: 'worth-a-detour', // traveler demoted this one
            },
          ],
        },
      ],
    }

    generateRegionHighlightsMock.mockReset()
    generateSkeletonFromHighlightsMock.mockReset().mockResolvedValue({
      days: [{ index: 0 }],
    })
    resolveSkeletonDaysMock
      .mockReset()
      .mockResolvedValue([fixtureGeneratedDay(0, '2026-08-01')])

    const { generateRealPlan } = await import('./generatePlan.js')
    const trip = await loadTrip(tripId)
    const days = await generateRealPlan(trip, tripRef, {
      kind: 'fromHighlights',
      highlights: editedHighlights as never,
      notesFreeText: `${trip.notes.freeText}\n\nMust include: a waterfall stop`,
    })

    expect(generateRegionHighlightsMock).not.toHaveBeenCalled()
    expect(generateSkeletonFromHighlightsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        highlights: editedHighlights,
        notesFreeText: expect.stringContaining('a waterfall stop'),
      }),
    )
    expect(days).toHaveLength(1)
  })
})

describe('generatePlan trigger: review-pause cost guard', () => {
  it('rejects a new full/replan request while paused for review, without disturbing the pause', async () => {
    const db = getFirestore()
    const { tripId } = await createTripForUser('uidReviewC')
    const tripRef = db.collection('trips').doc(tripId)

    await tripRef.update({
      'planMeta.status': 'awaiting-highlights-review',
      'planMeta.pendingHighlights': FIXTURE_HIGHLIGHTS,
    })

    const requestRef = await db.collection('planRequests').add({
      tripId,
      kind: 'full',
      status: 'pending',
    })

    const finalRequest = await waitFor(async () => {
      const snap = await requestRef.get()
      const data = snap.data()
      return data?.status === 'error' ? data : undefined
    })
    expect(finalRequest.error).toMatch(/already in progress/)

    const tripSnap = await tripRef.get()
    expect(tripSnap.data()?.planMeta.status).toBe('awaiting-highlights-review')
    expect(tripSnap.data()?.planMeta.pendingHighlights).toEqual(
      FIXTURE_HIGHLIGHTS,
    )
  }, 15_000)
})
