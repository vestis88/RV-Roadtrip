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
