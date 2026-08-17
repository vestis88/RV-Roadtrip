import { beforeEach, describe, expect, it, vi } from 'vitest'
import { describeEmptyCountries } from './exploreCandidateActions'
import type { CorridorStopPriority } from '@rv/shared'
import type { CorridorStopWithId } from '../hooks/useCorridorStops'

// The Firestore writes are the only thing worth faking here — the logic
// under test is which doc gets which priority, so the calls are captured
// and asserted rather than executed.
const updateDocMock = vi.fn().mockResolvedValue(undefined)

vi.mock('firebase/firestore', () => ({
  // doc() is stubbed to just echo the id it was asked for, so assertions can
  // identify which stop each write targeted.
  doc: (_db: unknown, ..._path: string[]) => ({ id: _path[_path.length - 1] }),
  updateDoc: (ref: { id: string }, data: unknown) => updateDocMock(ref.id, data),
}))
vi.mock('firebase/functions', () => ({ httpsCallable: () => vi.fn() }))
vi.mock('./firebase', () => ({ db: {}, functions: {} }))

const {
  candidatePriority,
  describeExploreHighlightsError,
  exploreAttemptBaseline,
  exploreFailureMessage,
  setCandidatePriority,
  sortCandidatesForList,
} = await import('./exploreCandidateActions')

const GENERIC = 'Could not find stops right now — please try again.'

// Regression for 2026-08-12: both callers replaced every failure with the
// generic line, so a server message written for exactly this moment never
// reached the traveler and a deterministic fault was reported as something a
// retry would fix.
describe('describeExploreHighlightsError', () => {
  it('shows the server message for the codes this callable raises itself', () => {
    expect(
      describeExploreHighlightsError({
        code: 'functions/failed-precondition',
        message: 'Already finding great stops for this trip — hang tight.',
      }),
    ).toBe('Already finding great stops for this trip — hang tight.')

    expect(
      describeExploreHighlightsError({
        code: 'functions/internal',
        message: 'Could not find stops: SyntaxError: Unexpected token.',
      }),
    ).toBe('Could not find stops: SyntaxError: Unexpected token.')
  })

  // firebase-functions' placeholder for a server error it could not
  // describe — shown as-is it would read as gibberish.
  it('falls back when the server error carries no real message', () => {
    expect(
      describeExploreHighlightsError({ code: 'functions/internal', message: 'INTERNAL' }),
    ).toBe(GENERIC)
    expect(
      describeExploreHighlightsError({ code: 'functions/internal', message: '  ' }),
    ).toBe(GENERIC)
  })

  // These codes come from the Firebase client, not from our callable, and
  // their message is just the code repeated back.
  //
  // 'deadline-exceeded' used to be in this list and has been deliberately
  // pulled out of it: it is the one transport failure the traveler can act
  // on, and "please try again" is the worst advice for it — see the
  // dedicated case below.
  it('falls back for transport-level failures and non-callable errors', () => {
    expect(describeExploreHighlightsError(new TypeError('Failed to fetch'))).toBe(
      GENERIC,
    )
    expect(describeExploreHighlightsError(undefined)).toBe(GENERIC)
  })
})

function stop(
  id: string,
  overrides: Partial<CorridorStopWithId> = {},
): CorridorStopWithId {
  return {
    id,
    name: id,
    lat: 60,
    lng: 10,
    country: 'NO',
    status: 'candidate',
    linkedDayIds: [],
    priority: 'worth-a-detour' as CorridorStopPriority,
    ...overrides,
  } as CorridorStopWithId
}

beforeEach(() => {
  updateDocMock.mockClear()
})

// Reported 2026-08-11: "let us choose the interest level per item through a
// selecter. Ie tap a button to choose the interest level." The up/down
// arrows this replaced moved a stop one category per tap, which only read
// as anything while the list was grouped by category.
describe('setCandidatePriority', () => {
  it('writes the chosen level straight to the stop', async () => {
    await setCandidatePriority('trip1', 'w1', 'must-see')

    expect(updateDocMock).toHaveBeenCalledWith('w1', { priority: 'must-see' })
  })

  it('reaches the bottom level in one tap from the top, skipping nothing', async () => {
    await setCandidatePriority('trip1', 'm1', 'nice-if-convenient')

    expect(updateDocMock).toHaveBeenCalledWith('m1', {
      priority: 'nice-if-convenient',
    })
  })

  // `rank` only ever ordered stops within a category, and the list no longer
  // has categories to order within.
  it('leaves rank alone', async () => {
    await setCandidatePriority('trip1', 'w1', 'must-see')

    const [, written] = updateDocMock.mock.calls[0]
    expect(written).not.toHaveProperty('rank')
  })
})

describe('candidatePriority', () => {
  it("keeps Claude's own pre-selected level", () => {
    expect(candidatePriority(stop('a', { priority: 'must-see' }))).toBe(
      'must-see',
    )
  })

  // A pin the traveler dropped themselves has no level yet, and the selector
  // has to show one of the three as chosen.
  it('falls back to the middle level for a stop that has none', () => {
    expect(candidatePriority(stop('a', { priority: undefined }))).toBe(
      'worth-a-detour',
    )
  })
})

describe('sortCandidatesForList', () => {
  const START = { lat: 55, lng: 12 }
  const END = { lat: 60, lng: 12 }

  it('orders stops the way the trip drives past them, whatever their interest level', () => {
    const ordered = sortCandidatesForList(
      [
        stop('far', { lat: 59, lng: 12, priority: 'nice-if-convenient' }),
        stop('near', { lat: 56, lng: 12, priority: 'must-see' }),
        stop('middle', { lat: 57.5, lng: 12, priority: 'worth-a-detour' }),
      ],
      START,
      END,
    )

    expect(ordered.map((s) => s.id)).toEqual(['near', 'middle', 'far'])
  })

  it('orders a stop off to the side by how far along the route it sits, not how far off it', () => {
    const ordered = sortCandidatesForList(
      [
        stop('late-but-close', { lat: 59, lng: 12.1 }),
        stop('early-but-distant', { lat: 56, lng: 14 }),
      ],
      START,
      END,
    )

    expect(ordered.map((s) => s.id)).toEqual([
      'early-but-distant',
      'late-but-close',
    ])
  })

  // A trip mid-edit may not have both ends yet; ordering along a corridor
  // needs both, so the list just stays as it came rather than shuffling.
  it('leaves the order alone when the trip has no finish point yet', () => {
    const given = [stop('b', { lat: 59, lng: 12 }), stop('a', { lat: 56, lng: 12 })]

    expect(
      sortCandidatesForList(given, START, undefined).map((s) => s.id),
    ).toEqual(['b', 'a'])
  })

  it('does not mutate the array it was given', () => {
    const given = [stop('b', { lat: 59, lng: 12 }), stop('a', { lat: 56, lng: 12 })]
    sortCandidatesForList(given, START, END)

    expect(given.map((s) => s.id)).toEqual(['b', 'a'])
  })
})

describe('describeExploreHighlightsError — a search that ran out of time', () => {
  // The generic "please try again" is the worst possible advice here:
  // re-running the identical search is the one thing guaranteed to take just
  // as long. Reported as three minutes of "Scanning…" followed by a failure.
  it('names what would make the search finish instead of advising a retry', () => {
    const message = describeExploreHighlightsError({
      code: 'functions/deadline-exceeded',
      message: 'deadline-exceeded',
    })

    expect(message).toMatch(/smaller area/i)
    expect(message).not.toMatch(/try again/i)
  })

  it('still falls back to the generic line for a failure it cannot explain', () => {
    expect(describeExploreHighlightsError({ code: 'functions/unavailable' })).toMatch(
      /try again/i,
    )
  })
})

describe('describeExploreHighlightsError — a message that is only the code', () => {
  // Reported as a red banner reading, in full, "internal". The guard only
  // rejected the exact uppercase "INTERNAL", so the lowercase spelling the
  // client emits went straight to the screen — a word that tells the
  // traveler nothing and tells whoever is debugging it even less.
  it('rejects the code echoed back, in either casing', () => {
    expect(
      describeExploreHighlightsError({ code: 'functions/internal', message: 'internal' }),
    ).toBe(GENERIC)
    expect(
      describeExploreHighlightsError({ code: 'functions/internal', message: 'INTERNAL' }),
    ).toBe(GENERIC)
    expect(
      describeExploreHighlightsError({
        code: 'functions/internal',
        message: 'functions/internal',
      }),
    ).toBe(GENERIC)
  })

  // The point of the whole path: a real cause still gets through.
  it('shows a cause the server actually wrote', () => {
    expect(
      describeExploreHighlightsError({
        code: 'functions/internal',
        message: 'Could not rescan: Overpass query failed with 406',
      }),
    ).toMatch(/406/)
  })
})

/**
 * A country picked in Trip Setup that produced nothing used to be said
 * nothing about — no screen mentioned it at all. See countryCoverage.ts.
 */
describe('describeEmptyCountries', () => {
  const nameOf = (code: string) => ({ EE: 'Estonia', LV: 'Latvia' })[code] ?? code

  it('says nothing when every chosen country produced something', () => {
    expect(describeEmptyCountries([], nameOf)).toBeNull()
  })

  it('names the country and passes on why nothing was suggested', () => {
    expect(
      describeEmptyCountries(
        [
          {
            country: 'EE',
            reason: 'not-proposed',
            proposed: 0,
            note: 'Nothing here answers downhill mountain biking.',
          },
        ],
        nameOf,
      ),
    ).toBe(
      'Estonia: nothing suggested — Nothing here answers downhill mountain biking.',
    )
  })

  it('still names the country when curation gave no reason', () => {
    expect(
      describeEmptyCountries(
        [{ country: 'EE', reason: 'not-proposed', proposed: 0 }],
        nameOf,
      ),
    ).toBe('Estonia: nothing suggested for this trip.')
  })

  // The other kind of empty, and a different problem: these existed, and the
  // map lookup lost them.
  it('distinguishes suggestions that could not be found on the map', () => {
    expect(
      describeEmptyCountries(
        [{ country: 'EE', reason: 'not-located', proposed: 3 }],
        nameOf,
      ),
    ).toBe(
      'Estonia: 3 suggestions came back but none of them could be found on the map.',
    )
  })

  it('reads correctly for a single unlocatable suggestion', () => {
    expect(
      describeEmptyCountries(
        [{ country: 'EE', reason: 'not-located', proposed: 1 }],
        nameOf,
      ),
    ).toBe(
      'Estonia: 1 suggestion came back but it could not be found on the map.',
    )
  })

  it('reports every empty country, not just the first', () => {
    const said = describeEmptyCountries(
      [
        { country: 'EE', reason: 'not-proposed', proposed: 0 },
        { country: 'LV', reason: 'not-located', proposed: 2 },
      ],
      nameOf,
    )
    expect(said).toContain('Estonia')
    expect(said).toContain('Latvia')
  })
})

// Reported 2026-08-17: "Could not find stops right now — please try again"
// under a Generate overview, on a trip whose status had already gone back to
// idle. That line is what the client says when the rejection carried no
// cause at all — a dropped connection, or a container that died without
// answering — and it is the wrong thing to say for every one of those cases.
describe('exploreFailureMessage', () => {
  const idle = { status: 'idle' as const, exploreStatus: 'idle' as const }

  it('says nothing at all when the call did not fail this way', () => {
    expect(exploreFailureMessage(null, idle)).toBeNull()
  })

  // The most common outcome of a phone locking mid-call: the function keeps
  // running, because the client hanging up does not cancel it.
  it('reports a search still running rather than a failure', () => {
    const notice = exploreFailureMessage(
      { lastRunAt: undefined, lastFailedAt: undefined },
      { ...idle, exploreStatus: 'generating' },
    )
    expect(notice?.tone).toBe('info')
    expect(notice?.message).toContain('running on the server')
  })

  // And when it turns out to have worked: telling the traveler to try again
  // would charge them a second Claude call for a search that succeeded.
  it('reports a search that finished after the connection dropped', () => {
    const notice = exploreFailureMessage(
      { lastRunAt: undefined, lastFailedAt: undefined },
      { ...idle, exploreLastRunAt: '2026-08-17T17:03:00.000Z' },
    )
    expect(notice?.tone).toBe('info')
    expect(notice?.message).toContain('finished on the server')
  })

  it('shows the server-recorded cause when the run really did fail', () => {
    const notice = exploreFailureMessage(
      { lastRunAt: undefined, lastFailedAt: undefined },
      {
        ...idle,
        exploreLastFailedAt: '2026-08-17T17:03:00.000Z',
        exploreLastError: 'Could not find stops: Places refused the key.',
      },
    )
    expect(notice).toEqual({
      tone: 'error',
      message: 'Could not find stops: Places refused the key.',
    })
  })

  // The whole reason the baseline is a before/after comparison rather than
  // "is the server's timestamp after I pressed the button": a stale failure
  // from last week is not news about the search just fired, and the two
  // clocks involved are a phone's and a datacentre's.
  it('ignores a failure that was already on the trip beforehand', () => {
    const planMeta = {
      ...idle,
      exploreLastFailedAt: '2026-08-10T09:00:00.000Z',
      exploreLastError: 'Could not find stops: an old problem.',
    }
    const notice = exploreFailureMessage(
      exploreAttemptBaseline(planMeta),
      planMeta,
    )
    expect(notice).toEqual({ tone: 'error', message: GENERIC })
  })

  it('ignores a successful run that predates this attempt', () => {
    const planMeta = { ...idle, exploreLastRunAt: '2026-08-10T09:00:00.000Z' }
    const notice = exploreFailureMessage(
      exploreAttemptBaseline(planMeta),
      planMeta,
    )
    expect(notice).toEqual({ tone: 'error', message: GENERIC })
  })

  // A trip that has both, from this attempt, is a retry: the later one is
  // what happened.
  it('prefers whichever of the two happened last', () => {
    const before = { lastRunAt: undefined, lastFailedAt: undefined }
    const failedLater = exploreFailureMessage(before, {
      ...idle,
      exploreLastRunAt: '2026-08-17T17:00:00.000Z',
      exploreLastFailedAt: '2026-08-17T17:05:00.000Z',
      exploreLastError: 'Could not find stops: the second try broke.',
    })
    expect(failedLater?.tone).toBe('error')
    expect(failedLater?.message).toContain('the second try broke')

    const ranLater = exploreFailureMessage(before, {
      ...idle,
      exploreLastRunAt: '2026-08-17T17:05:00.000Z',
      exploreLastFailedAt: '2026-08-17T17:00:00.000Z',
      exploreLastError: 'Could not find stops: the first try broke.',
    })
    expect(ranLater?.tone).toBe('info')
  })

  // Nothing to report is still better said plainly than dressed up as a
  // diagnosis — but it is now the last resort rather than the only answer.
  it('falls back to the generic line when the trip says nothing', () => {
    expect(
      exploreFailureMessage({ lastRunAt: undefined, lastFailedAt: undefined }, idle),
    ).toEqual({ tone: 'error', message: GENERIC })
  })
})
