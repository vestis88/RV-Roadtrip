import { describe, expect, it } from 'vitest'
import { planSkeleton } from './skeletonDays'
import type { CorridorStopWithId } from '../hooks/useCorridorStops'
import type { TripDayWithId } from '../hooks/useTripDays'

const SETTINGS = {
  startDate: '2026-07-01',
  endDate: '2026-07-14',
  maxDriveHoursPerDay: 5,
  startPoint: { name: 'Oslo', lat: 59.91, lng: 10.75 },
  endPoint: { name: 'Rome', lat: 41.9, lng: 12.5 },
}

function stop(over: Partial<CorridorStopWithId> = {}): CorridorStopWithId {
  return {
    id: over.id ?? 'a',
    name: over.name ?? 'Otta',
    lat: 61.77,
    lng: 9.54,
    country: 'NO',
    status: 'locked',
    linkedDayIds: [],
    ...over,
  } as CorridorStopWithId
}

const READY = { status: 'ready' as const }

describe('planSkeleton', () => {
  it('turns locked stops into dated days that fill themselves in later', () => {
    const { days } = planSkeleton({
      stops: [stop({ id: 'a', name: 'Otta' }), stop({ id: 'b', name: 'Lom' })],
      legs: [{ durationMin: 120, distanceKm: 150 }],
      existingDays: [],
      settings: SETTINGS,
      planMeta: READY,
    })
    expect(days).toBeDefined()
    expect(days![0].date).toBe('2026-07-01')
    // The whole point: cheap now, detailed when opened. DayDetailGate reads
    // exactly this.
    expect(days!.every((day) => day.detailStatus === 'pending')).toBe(true)
    expect(days![days!.length - 1].overnight.name).toBe('Lom')
  })

  /**
   * The guard that matters most. Detail is expensive and was chosen by
   * someone; a trip that has any belongs to runReconcileCorridor, which
   * moves days without discarding what is on them.
   */
  it('refuses to touch an itinerary that has real detail', () => {
    const decision = planSkeleton({
      stops: [stop()],
      legs: [],
      existingDays: [
        { id: 'd1', index: 0, detailStatus: 'ready' } as TripDayWithId,
      ],
      settings: SETTINGS,
      planMeta: READY,
    })
    expect(decision.skipped).toBe('has-detail')
    expect(decision.days).toBeUndefined()
  })

  // Two writers in one collection is how days end up interleaved.
  it('stands aside while a generation is running', () => {
    expect(
      planSkeleton({
        stops: [stop()],
        legs: [],
        existingDays: [],
        settings: SETTINGS,
        planMeta: { status: 'generating' },
      }).skipped,
    ).toBe('plan-busy')
  })

  // overnightStopSchema requires a two-letter country; a malformed day
  // would surface a long way from here.
  it('skips a stop with no country rather than writing a broken day', () => {
    const decision = planSkeleton({
      stops: [stop({ id: 'a', country: undefined })],
      legs: [],
      existingDays: [],
      settings: SETTINGS,
      planMeta: READY,
    })
    expect(decision.skipped).toBe('no-stops')
  })

  it('writes nothing when the itinerary already says this', () => {
    const first = planSkeleton({
      stops: [stop()],
      legs: [],
      existingDays: [],
      settings: SETTINGS,
      planMeta: READY,
    })
    const asStored = first.days!.map((day, i) => ({
      ...day,
      id: `d${i}`,
    })) as TripDayWithId[]

    expect(
      planSkeleton({
        stops: [stop()],
        legs: [],
        existingDays: asStored,
        settings: SETTINGS,
        planMeta: READY,
      }).skipped,
    ).toBe('unchanged')
  })

  it('needs dates before it can date anything', () => {
    expect(
      planSkeleton({
        stops: [stop()],
        legs: [],
        existingDays: [],
        settings: { ...SETTINGS, startDate: '', endDate: '' },
        planMeta: READY,
      }).skipped,
    ).toBe('no-dates')
  })

  // A basecamp's extra nights become rest days, whose overnight matches the
  // day before by construction — which is the one invariant validatePacing
  // still enforces.
  it('writes a basecamp’s extra nights as rest days in the same place', () => {
    const { days } = planSkeleton({
      stops: [stop({ stayDuration: { kind: 'nights', nights: 3 } })],
      legs: [{ durationMin: 60, distanceKm: 80 }],
      existingDays: [],
      settings: SETTINGS,
      planMeta: READY,
    })
    expect(days).toHaveLength(3)
    expect(days![1].type).toBe('rest')
    expect(days![1].overnight.name).toBe(days![0].overnight.name)
    expect(days![2].date).toBe('2026-07-03')
  })
})

/**
 * Reported 2026-08-24: "The list of day plans on top does not seem to update
 * dynamically… My intention was to not have to interact in the same way with
 * the day view."
 *
 * The automatic writer refuses a trip whose days carry detail, which is
 * right — that detail was paid for. It also meant nothing recomputed the day
 * list from the board once a trip had been generated and any day opened, so
 * the strip sat frozen. `rebuildOverDetail` is the explicit door beside that
 * guard.
 */
describe('rebuilding the day list over researched detail', () => {
  const base = {
    stops: [
      stop({ id: 's1', name: 'Füssen' }),
      stop({ id: 's2', name: 'Lucerne' }),
    ],
    legs: [{ durationMin: 120, distanceKm: 150 }],
    settings: {
      startDate: '2026-08-20',
      endDate: '2026-09-20',
      maxDriveHoursPerDay: 5,
      startPoint: { name: 'Munich', lat: 48.14, lng: 11.58 },
      endPoint: { name: 'Zurich', lat: 47.37, lng: 8.54 },
    },
    planMeta: { status: 'ready' as const },
  }
  const detailedDays = [
    {
      id: 'd1',
      index: 0,
      date: '2026-08-20',
      type: 'drive' as const,
      overnight: { name: 'Somewhere else', lat: 0, lng: 0, country: 'DE' },
      summary: '',
      detailStatus: 'ready' as const,
    },
  ]

  it('still refuses by default, so the automatic writer cannot discard detail', () => {
    const decision = planSkeleton({ ...base, existingDays: detailedDays })
    expect(decision.skipped).toBe('has-detail')
    expect(decision.days).toBeUndefined()
  })

  it('goes ahead when the traveler asks for it explicitly', () => {
    const decision = planSkeleton({
      ...base,
      existingDays: detailedDays,
      rebuildOverDetail: true,
    })
    expect(decision.skipped).toBeUndefined()
    expect(decision.days?.length).toBeGreaterThan(0)
    // Rebuilt from the board, so the overnight is a kept stop rather than
    // whatever the frozen list said.
    expect(decision.days?.[0].overnight.name).not.toBe('Somewhere else')
  })

  /**
   * An explicit rebuild must produce days even when the dates and overnights
   * happen to match — otherwise pressing the button on a trip whose only
   * divergence is its DETAIL would silently do nothing.
   */
  it('is not short-circuited by the unchanged check', () => {
    const first = planSkeleton({ ...base, existingDays: [] })
    const asExisting = (first.days ?? []).map((day, index) => ({
      ...day,
      id: `d${index}`,
      detailStatus: 'ready' as const,
    }))
    const again = planSkeleton({
      ...base,
      existingDays: asExisting,
      rebuildOverDetail: true,
    })
    expect(again.skipped).toBeUndefined()
    expect(again.days?.length).toBe(asExisting.length)
  })

  // The guards that are about the trip being un-plannable still apply — an
  // explicit request cannot conjure dates.
  it('still refuses without dates', () => {
    const decision = planSkeleton({
      ...base,
      settings: { ...base.settings, startDate: '', endDate: '' },
      existingDays: detailedDays,
      rebuildOverDetail: true,
    })
    expect(decision.skipped).toBe('no-dates')
  })
})

/**
 * Requested 2026-08-25 alongside per-section fill. A day whose lunch was
 * filled by hand is still `pending` — correctly, since the rest was never
 * asked for — so `detailStatus` alone stopped being enough to answer "is
 * there anything here somebody paid for".
 */
describe('protecting hand-filled sections', () => {
  const base = {
    stops: [stop({ id: 's1', name: 'Füssen' })],
    legs: [],
    settings: SETTINGS,
    planMeta: READY,
  }

  it('refuses to rebuild over a day with a filled section', () => {
    const decision = planSkeleton({
      ...base,
      existingDays: [
        {
          id: 'd1',
          index: 0,
          date: '2026-07-01',
          type: 'drive' as const,
          overnight: { name: 'Elsewhere', lat: 0, lng: 0, country: 'NO' },
          summary: '',
          detailStatus: 'pending' as const,
          filledSections: ['lunch' as const],
        },
      ],
    })
    expect(decision.skipped).toBe('has-detail')
  })

  // An empty list is the same as never having asked — every skeleton day and
  // every day written before this existed.
  it('still rebuilds over a day that has asked for nothing', () => {
    const decision = planSkeleton({
      ...base,
      existingDays: [
        {
          id: 'd1',
          index: 0,
          date: '2026-07-01',
          type: 'drive' as const,
          overnight: { name: 'Elsewhere', lat: 0, lng: 0, country: 'NO' },
          summary: '',
          detailStatus: 'pending' as const,
          filledSections: [],
        },
      ],
    })
    expect(decision.skipped).toBeUndefined()
    expect(decision.days?.length).toBeGreaterThan(0)
  })

  // The explicit rebuild still overrides it — the traveler is told what it
  // discards and chose anyway.
  it('lets an explicit rebuild go ahead regardless', () => {
    const decision = planSkeleton({
      ...base,
      rebuildOverDetail: true,
      existingDays: [
        {
          id: 'd1',
          index: 0,
          date: '2026-07-01',
          type: 'drive' as const,
          overnight: { name: 'Elsewhere', lat: 0, lng: 0, country: 'NO' },
          summary: '',
          filledSections: ['activity' as const],
        },
      ],
    })
    expect(decision.skipped).toBeUndefined()
  })
})
