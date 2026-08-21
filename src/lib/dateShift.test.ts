import { describe, expect, it, vi } from 'vitest'

const batchUpdate = vi.fn()
const batchCommit = vi.fn().mockResolvedValue(undefined)
vi.mock('firebase/firestore', () => ({
  doc: (_db: unknown, ...path: string[]) => ({ path: path.join('/') }),
  writeBatch: () => ({ update: batchUpdate, commit: batchCommit }),
}))
vi.mock('./firebase', () => ({ db: {} }))

const { addDays, describeDateShift, detectDateShift, shiftPlanDates } =
  await import('./dateShift')

const READY_DATES = ['2026-07-10', '2026-07-11', '2026-07-12', '2026-07-13']

function detect(
  settings: { startDate: string; endDate: string },
  planMeta: Record<string, unknown>,
  dayDates = READY_DATES,
) {
  return detectDateShift({
    settings,
    planMeta: { status: 'stale', ...planMeta } as never,
    dayDates,
  })
}

// Requested 2026-08-19: "how to just change dates of the trip then?" — the
// cheapest correct operation was the most expensive one available.
describe('detectDateShift', () => {
  it('offers a shift when the trip moved but kept its length', () => {
    const shift = detect(
      { startDate: '2026-07-17', endDate: '2026-07-20' },
      { staleSettings: ['startDate', 'endDate'] },
    )
    expect(shift).toEqual({
      offsetDays: 7,
      from: '2026-07-10',
      to: '2026-07-17',
    })
  })

  it('works backwards too', () => {
    expect(
      detect(
        { startDate: '2026-07-08', endDate: '2026-07-11' },
        { staleSettings: ['startDate', 'endDate'] },
      )?.offsetDays,
    ).toBe(-2)
  })

  // Adding or removing days is a real planning problem — where the extra
  // night goes, what gets cut — and re-dating cannot answer it.
  it('refuses when the trip changed length', () => {
    expect(
      detect(
        { startDate: '2026-07-17', endDate: '2026-07-25' },
        { staleSettings: ['startDate', 'endDate'] },
      ),
    ).toBeNull()
  })

  // The reason the staleness reason is recorded at all: re-dating fully
  // answers a date change and says nothing about a drive-hours ceiling.
  it('refuses when something other than the dates also changed', () => {
    expect(
      detect(
        { startDate: '2026-07-17', endDate: '2026-07-20' },
        { staleSettings: ['startDate', 'maxDriveHoursPerDay'] },
      ),
    ).toBeNull()
  })

  // A plan older than the field carries no reason, and a missing reason is
  // not the same as "only the dates".
  it('refuses when the plan does not record why it went stale', () => {
    expect(
      detect({ startDate: '2026-07-17', endDate: '2026-07-20' }, {}),
    ).toBeNull()
  })

  it('offers nothing for a plan that is not stale', () => {
    expect(
      detectDateShift({
        settings: { startDate: '2026-07-17', endDate: '2026-07-20' },
        planMeta: { status: 'ready', staleSettings: ['startDate'] } as never,
        dayDates: READY_DATES,
      }),
    ).toBeNull()
  })

  it('offers nothing when the dates already match', () => {
    expect(
      detect(
        { startDate: '2026-07-10', endDate: '2026-07-13' },
        { staleSettings: ['startDate'] },
      ),
    ).toBeNull()
  })

  it('offers nothing for a trip with no days yet', () => {
    expect(
      detect(
        { startDate: '2026-07-17', endDate: '2026-07-20' },
        { staleSettings: ['startDate'] },
        [],
      ),
    ).toBeNull()
  })
})

describe('addDays', () => {
  it('crosses a month boundary', () => {
    expect(addDays('2026-07-30', 3)).toBe('2026-08-02')
  })

  // The trip this app plans routinely crosses one, and getting it wrong
  // would move exactly one day of the plan.
  it('is unaffected by daylight saving', () => {
    expect(addDays('2026-03-28', 2)).toBe('2026-03-30')
    expect(addDays('2026-10-24', 2)).toBe('2026-10-26')
  })

  it('goes backwards', () => {
    expect(addDays('2026-01-01', -1)).toBe('2025-12-31')
  })
})

describe('describeDateShift', () => {
  it('says which way, in days', () => {
    expect(
      describeDateShift({ offsetDays: 7, from: 'a', to: 'b' }),
    ).toBe('Move the plan 7 days later')
    expect(
      describeDateShift({ offsetDays: -1, from: 'a', to: 'b' }),
    ).toBe('Move the plan 1 day earlier')
  })
})

describe('shiftPlanDates', () => {
  it('re-dates every day and clears the staleness, in one batch', async () => {
    batchUpdate.mockClear()
    batchCommit.mockClear()

    await shiftPlanDates(
      'trip1',
      [
        { id: 'd1', date: '2026-07-10' },
        { id: 'd2', date: '2026-07-11' },
      ],
      7,
    )

    expect(batchUpdate).toHaveBeenCalledWith(
      { path: 'trips/trip1/days/d1' },
      { date: '2026-07-17' },
    )
    expect(batchUpdate).toHaveBeenCalledWith(
      { path: 'trips/trip1/days/d2' },
      { date: '2026-07-18' },
    )
    expect(batchUpdate).toHaveBeenCalledWith(
      { path: 'trips/trip1' },
      { 'planMeta.status': 'ready', 'planMeta.staleSettings': [] },
    )
    // One commit — a half-shifted plan would be a worse state than the one
    // being fixed.
    expect(batchCommit).toHaveBeenCalledTimes(1)
  })
})
