import { describe, expect, it } from 'vitest'
import { planSkeleton } from './skeletonDays'
import type { TripDay } from '@rv/shared'
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
   * The guard that matters most, and it asks a narrower question than it
   * used to (2026-08-31, "why do I need to rebuild the daylist?").
   *
   * It once refused whenever ANY day carried detail, which was right while a
   * rebuild deleted every day and every subcollection. Once days are reused
   * by overnight, that forbade the safe case along with the unsafe one and
   * froze the day list on every generated trip. Now it refuses only when
   * this particular rebuild would DISCARD research — a day whose place has
   * left the route — which is the one thing worth stopping to ask about.
   */
  it('refuses when a researched day would be discarded', () => {
    const decision = planSkeleton({
      stops: [stop({ name: 'Otta' })],
      legs: [],
      existingDays: [
        {
          id: 'd1',
          index: 0,
          date: '2026-07-01',
          type: 'drive',
          // Nowhere near the kept stop, so nothing reuses it.
          overnight: { name: 'Rothenburg', lat: 49.37, lng: 10.18, country: 'DE' },
          summary: 'A researched day.',
          detailStatus: 'ready',
        } as unknown as TripDayWithId,
      ],
      settings: SETTINGS,
      planMeta: READY,
    })
    expect(decision.skipped).toBe('has-detail')
    expect(decision.days).toBeUndefined()
  })

  /**
   * The behaviour the whole change is for: *"I want days to organically
   * create themselves based on the planned activities and their duration
   * continuously."*
   *
   * A researched day whose place is still on the route survives the
   * rebuild, so there is nothing to approve and nothing to stop for. The
   * old guard refused this outright, which is why the traveler had to keep
   * pressing a button to keep their own itinerary current.
   */
  it('goes ahead on its own when every researched day survives', () => {
    const decision = planSkeleton({
      stops: [stop({ id: 'a', name: 'Otta' })],
      legs: [],
      existingDays: [
        {
          id: 'd1',
          // A date the board no longer agrees with — the reason to rewrite.
          index: 0,
          date: '2026-06-01',
          type: 'drive',
          overnight: { name: 'Otta', lat: 61.77, lng: 9.54, country: 'NO' },
          summary: 'Researched, and still on the route.',
          detailStatus: 'ready',
        } as unknown as TripDayWithId,
      ],
      settings: SETTINGS,
      planMeta: READY,
    })
    expect(decision.skipped).toBeUndefined()
    expect(decision.days?.[0].date).toBe('2026-07-01')
    expect(decision.discardingDetail).toBe(0)
  })

  /**
   * ABSENT MEANS READY — tripDaySchema says so, and generation omits the
   * field entirely on a day it detailed in the window. Reading absent as
   * "no detail" was backwards for exactly the days with the most research
   * on them, and would have let the unattended writer drop one.
   */
  it('treats a day with no detailStatus as researched, not as bare', () => {
    const decision = planSkeleton({
      stops: [stop({ name: 'Otta' })],
      legs: [],
      existingDays: [
        {
          id: 'd1',
          index: 0,
          date: '2026-07-01',
          type: 'drive',
          overnight: { name: 'Rothenburg', lat: 49.37, lng: 10.18, country: 'DE' },
          summary: 'Generated and detailed, with no status field at all.',
        } as unknown as TripDayWithId,
      ],
      settings: SETTINGS,
      planMeta: READY,
    })
    expect(decision.skipped).toBe('has-detail')
  })

  // One malformed document must not take the board down: this runs against
  // every stored day on every render now, not behind a guard.
  it('survives a day with no overnight at all', () => {
    expect(() =>
      planSkeleton({
        stops: [stop()],
        legs: [],
        existingDays: [{ id: 'd1', index: 0 } as TripDayWithId],
        settings: SETTINGS,
        planMeta: READY,
      }),
    ).not.toThrow()
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

  /**
   * Reported 2026-08-26 as "which button do I push" and then as the rebuild
   * appearing to do nothing: pressing "Rebuild day list" wrote the days and
   * left the "these days are from an earlier plan" banner standing.
   *
   * The banner asks `stopsAddableToRoute` — "is this a kept stop with no
   * day" — so days written without linking every packed stop back to them
   * cannot clear it. Which stop landed on which day is only known here, in
   * the packing, so it has to come back out with the days.
   */
  it('says which stops landed on which day, so they can be linked back', () => {
    const { days, stopIdsByDay } = planSkeleton({
      stops: [stop({ id: 'a', name: 'Otta' }), stop({ id: 'b', name: 'Lom' })],
      legs: [{ durationMin: 120, distanceKm: 150 }],
      existingDays: [],
      settings: SETTINGS,
      planMeta: READY,
    })
    expect(stopIdsByDay).toHaveLength(days!.length)
    // Every kept stop is claimed by exactly one day — a stop left out is a
    // stop the board goes on calling day-less.
    expect(stopIdsByDay!.flat().sort()).toEqual(['a', 'b'])
  })

  // A parked night carries no `stops` of its own — the basecamp sits on the
  // first of its nights — so `parkedAt` is what links the rest of them. Left
  // to `stops` alone, the extra nights would claim nobody.
  it('links a basecamp to every night it is parked for', () => {
    const { stopIdsByDay } = planSkeleton({
      stops: [stop({ id: 'a', stayDuration: { kind: 'nights', nights: 3 } })],
      legs: [{ durationMin: 60, distanceKm: 80 }],
      existingDays: [],
      settings: SETTINGS,
      planMeta: READY,
    })
    expect(stopIdsByDay).toEqual([['a'], ['a'], ['a']])
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

/**
 * Asked on 2026-08-31: *"What's up with this rebuilding warning? Does it
 * have to warn? What does it have to discard? Can it not just keep already
 * generated days available, if they would be done at a later point in
 * time?"*
 *
 * It does not have to discard much. A day's researched activities and
 * restaurants belong to the PLACE it is spent in, not the date it was given
 * — a lunch spot in Riva del Garda is still one when the day moves from the
 * 2nd to the 4th. The old rebuild deleted every day because it matched them
 * by nothing at all.
 */
describe('reusing days a rebuild does not actually invalidate', () => {
  const day = (index: number, date: string, name: string): TripDay =>
    ({
      index,
      date,
      type: 'drive',
      overnight: { name, lat: 45.88, lng: 10.84, country: 'IT' },
      summary: `On to ${name}.`,
    }) as TripDay

  const stored = (
    id: string,
    index: number,
    date: string,
    name: string,
    over: Partial<TripDayWithId> = {},
  ): TripDayWithId =>
    ({ id, ...day(index, date, name), ...over }) as TripDayWithId

  it('re-dates a day in place rather than deleting and rewriting it', async () => {
    const { planSkeletonWrite } = await import('./skeletonDays')
    const plan = planSkeletonWrite(
      [stored('d1', 0, '2026-09-02', 'Riva del Garda')],
      [day(0, '2026-09-04', 'Riva del Garda')],
    )
    expect(plan.reuse.map((entry) => entry.id)).toEqual(['d1'])
    expect(plan.create).toHaveLength(0)
    expect(plan.removeIds).toHaveLength(0)
    // Which is what makes the warning unnecessary: nothing researched is lost.
    expect(plan.discardingDetail).toBe(0)
  })

  /**
   * The case the name key alone would miss: a generated day's overnight
   * moves off the town centre onto an actual campsite and takes the site's
   * name with it, while the skeleton names the stop. Same place, different
   * label — so the coordinates decide.
   */
  it('matches a campsite overnight to the town the skeleton names', async () => {
    const { planSkeletonWrite } = await import('./skeletonDays')
    const plan = planSkeletonWrite(
      [stored('d1', 0, '2026-09-02', 'Camping Bavaria Riva')],
      [day(0, '2026-09-04', 'Riva del Garda')],
    )
    expect(plan.reuse.map((entry) => entry.id)).toEqual(['d1'])
  })

  // Claimed at most once, or a basecamp's three nights would all reuse the
  // same stored day and two of them would quietly vanish.
  it('gives a basecamp’s nights a day each', async () => {
    const { planSkeletonWrite } = await import('./skeletonDays')
    const plan = planSkeletonWrite(
      [
        stored('d1', 0, '2026-09-01', 'Molveno'),
        stored('d2', 1, '2026-09-02', 'Molveno'),
      ],
      [
        day(0, '2026-09-03', 'Molveno'),
        day(1, '2026-09-04', 'Molveno'),
        day(2, '2026-09-05', 'Molveno'),
      ],
    )
    expect(plan.reuse.map((entry) => entry.id)).toEqual(['d1', 'd2'])
    expect(plan.create.map((entry) => entry.dayIndex)).toEqual([2])
    expect(plan.removeIds).toHaveLength(0)
  })

  // A stop taken off the route really is gone, and its research goes with
  // it — this is the only case the panel has anything to say about.
  it('drops a day whose place is no longer on the route, and counts it', async () => {
    const { planSkeletonWrite } = await import('./skeletonDays')
    const plan = planSkeletonWrite(
      [
        stored('keep', 0, '2026-09-01', 'Riva del Garda'),
        stored('gone', 1, '2026-09-02', 'Sirmione', {
          detailStatus: 'ready',
        } as Partial<TripDayWithId>),
        // `detailStatus: 'pending'` is what "nothing researched here" looks
        // like on the wire — an ABSENT status means ready, per the schema.
        stored('bare', 2, '2026-09-03', 'Verona', {
          detailStatus: 'pending',
        } as Partial<TripDayWithId>),
      ],
      [day(0, '2026-09-04', 'Riva del Garda')],
    )
    expect(plan.removeIds.sort()).toEqual(['bare', 'gone'])
    // Only the researched one is worth mentioning; a bare skeleton day is
    // not a loss and saying so would make the warning noise again.
    expect(plan.discardingDetail).toBe(1)
  })

  /**
   * What a reused day takes, and what it keeps. The overnight is the half
   * that matters: the stored one may carry a campsite suggestion or a
   * free-camping rule the skeleton has never heard of, and it is the same
   * place by construction.
   */
  it('takes the new dates and keeps the researched overnight and summary', async () => {
    const { reusedDayFields } = await import('./skeletonDays')
    const was = stored('d1', 0, '2026-09-02', 'Camping Bavaria Riva', {
      detailStatus: 'ready',
      summary: 'A long lunch on the lakefront, then the Ponale path.',
    } as Partial<TripDayWithId>)
    const fields = reusedDayFields(day(3, '2026-09-05', 'Riva del Garda'), was)

    expect(fields.date).toBe('2026-09-05')
    expect(fields.index).toBe(3)
    expect(fields).not.toHaveProperty('overnight')
    expect(fields).not.toHaveProperty('summary')
    // Never mentioned, so never overwritten — the whole point.
    expect(fields).not.toHaveProperty('detailStatus')
    expect(fields).not.toHaveProperty('filledSections')
  })

  it('gives a day with no research the new summary', async () => {
    const { reusedDayFields } = await import('./skeletonDays')
    const fields = reusedDayFields(
      day(1, '2026-09-05', 'Riva del Garda'),
      stored('d1', 0, '2026-09-02', 'Riva del Garda', {
        detailStatus: 'pending',
      } as Partial<TripDayWithId>),
    )
    expect(fields.summary).toBe('On to Riva del Garda.')
  })
})

/**
 * The "unchanged" check and the writer have to agree on what the same day
 * IS, or the automatic writer rewrites a reused day on every visit to the
 * map: it keeps the campsite name it was researched under while the
 * skeleton names the stop, and a name comparison calls that a change
 * forever.
 */
describe('recognising an itinerary that already says this', () => {
  const settings = { ...SETTINGS, startDate: '2026-07-01' }

  it('leaves a reused day alone when only its label differs', () => {
    const decision = planSkeleton({
      stops: [stop({ id: 'a', name: 'Riva del Garda' })],
      legs: [],
      existingDays: [
        {
          id: 'd1',
          index: 0,
          date: '2026-07-01',
          type: 'drive',
          // The campsite the day was researched under, 400 m from the stop.
          overnight: {
            name: 'Camping Bavaria Riva',
            lat: 61.77,
            lng: 9.54,
            country: 'NO',
          },
          summary: 'A day by the lake.',
        } as unknown as TripDayWithId,
      ],
      settings,
      planMeta: READY,
    })
    expect(decision.skipped).toBe('unchanged')
  })

  // And still notices a real move, which is the whole point of the check.
  it('still sees a date that has actually changed', () => {
    const decision = planSkeleton({
      stops: [stop({ id: 'a', name: 'Riva del Garda' })],
      legs: [],
      existingDays: [
        {
          id: 'd1',
          index: 0,
          date: '2026-06-20',
          type: 'drive',
          overnight: {
            name: 'Riva del Garda',
            lat: 61.77,
            lng: 9.54,
            country: 'NO',
          },
          summary: 'A day by the lake.',
        } as unknown as TripDayWithId,
      ],
      settings,
      planMeta: READY,
    })
    expect(decision.days).toBeDefined()
  })
})

/**
 * Reported 2026-09-02: *"I went in to add alternative overnight stops through
 * change overnight stops. It was not saved now that I went back to the same
 * day."*
 *
 * The first cause was that choosing submitted a replan that never ran. The
 * second would have bitten the moment the first was fixed: a campsite can
 * sit 15 km outside the town its day is built around, so matching a stored
 * day by where it SLEEPS makes it unrecognisable to the writer that
 * preserves it — and the next pass deletes it and writes a fresh one, taking
 * the choice with it. `townAnchor` is the day's identity; the bed is a
 * decision about it.
 */
describe('a day whose overnight has been moved off its town', () => {
  const stored = (over: Partial<TripDayWithId>): TripDayWithId =>
    ({
      id: 'd1',
      index: 0,
      date: '2026-09-02',
      type: 'drive',
      summary: 'A day by the lake.',
      ...over,
    }) as TripDayWithId

  it('is still recognised by the town it belongs to', async () => {
    const { planSkeletonWrite } = await import('./skeletonDays')
    const plan = planSkeletonWrite(
      [
        stored({
          // Chosen campsite, well outside the town and under another name.
          overnight: {
            name: 'Camping Bella Italia',
            lat: 45.44,
            lng: 10.71,
            country: 'IT',
          },
          // Where the day actually belongs.
          townAnchor: { lat: 45.88, lng: 10.84 },
        }),
      ],
      [
        {
          index: 0,
          date: '2026-09-04',
          type: 'drive',
          overnight: {
            name: 'Riva del Garda',
            lat: 45.88,
            lng: 10.84,
            country: 'IT',
          },
          summary: 'On to Riva del Garda.',
        } as TripDay,
      ],
    )
    expect(plan.reuse.map((entry) => entry.id)).toEqual(['d1'])
    expect(plan.removeIds).toHaveLength(0)
  })

  // Without the anchor the same day is unmatchable, which is precisely the
  // deletion this guards against.
  it('would be lost without one', async () => {
    const { planSkeletonWrite } = await import('./skeletonDays')
    const plan = planSkeletonWrite(
      [
        stored({
          overnight: {
            name: 'Camping Bella Italia',
            lat: 45.44,
            lng: 10.71,
            country: 'IT',
          },
        }),
      ],
      [
        {
          index: 0,
          date: '2026-09-04',
          type: 'drive',
          overnight: {
            name: 'Riva del Garda',
            lat: 45.88,
            lng: 10.84,
            country: 'IT',
          },
          summary: 'On to Riva del Garda.',
        } as TripDay,
      ],
    )
    expect(plan.removeIds).toEqual(['d1'])
  })
})

/**
 * Reported 2026-09-02, on a day in the Dolomites: *"Lüneburg, Tyskland →
 * Folgaride bike park · 42 km · 59 min"*, with the note *"there is also
 * mentions of the origin being the trip origin for the first night."*
 *
 * The distance and the time were the real leg from the previous Italian
 * stop; the NAME was the trip's start point, a thousand kilometres north.
 * `toTripDay` was handed an index and a settings object and nothing about
 * the day before it.
 */
describe('what a day says it drove from', () => {
  const stopAt = (id: string, name: string): CorridorStopWithId =>
    ({
      id,
      name,
      lat: 46 + Number(id.slice(1)) / 100,
      lng: 11,
      country: 'IT',
      status: 'locked',
      linkedDayIds: [],
      timeNeeded: 'half-day',
    }) as CorridorStopWithId

  it('names the night before, not the start of the trip', () => {
    const { days } = planSkeleton({
      stops: [stopAt('s1', 'Molveno'), stopAt('s2', 'Folgaride bike park')],
      legs: [
        { durationMin: 120, distanceKm: 90 },
        { durationMin: 59, distanceKm: 42 },
      ],
      existingDays: [],
      settings: SETTINGS,
      planMeta: READY,
      originName: 'Lüneburg, Tyskland',
    })
    // The first day genuinely does leave from where the route starts.
    expect(days![0].drive?.fromName).toBe('Lüneburg, Tyskland')
    // Every later one leaves from where it slept, and never from the
    // placeholder "Previous stop" this used to write.
    expect(days![1].drive?.fromName).toBe('Molveno')
    expect(days![1].drive?.toName).toBe('Folgaride bike park')
    expect(days![1].drive?.distanceKm).toBe(42)
  })

  // On the road the route starts from the van, and the first day has to say
  // so rather than naming a start point left behind weeks ago.
  it('leaves from where the route actually starts', () => {
    const { days } = planSkeleton({
      stops: [stopAt('s1', 'Molveno')],
      legs: [{ durationMin: 30, distanceKm: 20 }],
      existingDays: [],
      settings: SETTINGS,
      planMeta: READY,
      originName: 'Where we are',
    })
    expect(days![0].drive?.fromName).toBe('Where we are')
  })

  /**
   * And a day that reaches no stop has not moved the night anywhere. It used
   * to take `allStops[0]` — the first stop of the whole trip — which is the
   * other half of how a night in Italy got labelled with a town in Germany.
   */
  it('keeps last night’s overnight through a pure driving day', () => {
    const { days } = planSkeleton({
      stops: [stopAt('s1', 'Molveno'), stopAt('s2', 'Rome')],
      // Two days of driving between them, so a day in the middle reaches
      // nothing at all.
      legs: [
        { durationMin: 60, distanceKm: 40 },
        { durationMin: 900, distanceKm: 800 },
      ],
      existingDays: [],
      settings: SETTINGS,
      planMeta: READY,
      originName: 'Lüneburg, Tyskland',
    })
    const driveOnly = days!.filter(
      (day) => day.overnight.name === 'Molveno' && day.index > 0,
    )
    expect(driveOnly.length).toBeGreaterThan(0)
    expect(days!.some((day) => day.drive?.fromName === 'Previous stop')).toBe(
      false,
    )
  })
})
