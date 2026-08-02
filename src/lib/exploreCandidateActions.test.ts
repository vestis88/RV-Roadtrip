import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CorridorStopPriority } from '@rv/shared'
import type { CorridorStopWithId } from '../hooks/useCorridorStops'

// The Firestore writes are the only thing worth faking here — the logic
// under test is which doc gets which {priority, rank}, so the calls are
// captured and asserted rather than executed.
const batchUpdate = vi.fn()
const batchCommit = vi.fn().mockResolvedValue(undefined)
const updateDocMock = vi.fn().mockResolvedValue(undefined)

vi.mock('firebase/firestore', () => ({
  // doc() is stubbed to just echo the id it was asked for, so assertions can
  // identify which stop each write targeted.
  doc: (_db: unknown, ..._path: string[]) => ({ id: _path[_path.length - 1] }),
  updateDoc: (ref: { id: string }, data: unknown) => updateDocMock(ref.id, data),
  writeBatch: () => ({
    update: (ref: { id: string }, data: unknown) => batchUpdate(ref.id, data),
    commit: batchCommit,
  }),
}))
vi.mock('firebase/functions', () => ({ httpsCallable: () => vi.fn() }))
vi.mock('./firebase', () => ({ db: {}, functions: {} }))

const { voteExploreCandidate, groupCandidatesByPriority } = await import(
  './exploreCandidateActions'
)

function stop(
  id: string,
  priority: CorridorStopPriority,
  rank: number,
): CorridorStopWithId {
  return {
    id,
    name: id,
    lat: 60,
    lng: 10,
    country: 'NO',
    status: 'candidate',
    linkedDayIds: [],
    priority,
    rank,
  } as CorridorStopWithId
}

beforeEach(() => {
  batchUpdate.mockClear()
  batchCommit.mockClear()
  updateDocMock.mockClear()
})

describe('voteExploreCandidate', () => {
  // Reported 2026-08-02: "promoting cards in overview mode should move them a
  // full category, not just one step up/down." A stop mid-tier used to need
  // one tap per sibling before its category changed at all, and every tap
  // before the last looked like nothing had happened.
  it('promotes a whole category from the middle of its tier, in one vote', async () => {
    const grouped = groupCandidatesByPriority([
      stop('m1', 'must-see', 0),
      stop('m2', 'must-see', 1),
      stop('w1', 'worth-a-detour', 0),
      stop('w2', 'worth-a-detour', 1),
      stop('w3', 'worth-a-detour', 2),
    ])

    await voteExploreCandidate('trip1', grouped, 'w2', 'up')

    // Lands at must-see's bottom edge — the shortest visible move across the
    // boundary, not a leap to the very top.
    expect(updateDocMock).toHaveBeenCalledWith('w2', {
      priority: 'must-see',
      rank: 2,
    })
    // No rank-swapping with siblings any more.
    expect(batchUpdate).not.toHaveBeenCalled()
  })

  it('demotes a whole category from the middle of its tier, in one vote', async () => {
    const grouped = groupCandidatesByPriority([
      stop('m1', 'must-see', 0),
      stop('m2', 'must-see', 1),
      stop('m3', 'must-see', 2),
      stop('w1', 'worth-a-detour', 0),
      stop('w2', 'worth-a-detour', 1),
    ])

    await voteExploreCandidate('trip1', grouped, 'm2', 'down')

    // Enters worth-a-detour at its top edge.
    expect(updateDocMock).toHaveBeenCalledWith('m2', {
      priority: 'worth-a-detour',
      rank: -1,
    })
    expect(batchUpdate).not.toHaveBeenCalled()
  })

  it('skips no category: worth-a-detour demotes to nice-if-convenient, not past it', async () => {
    const grouped = groupCandidatesByPriority([
      stop('w1', 'worth-a-detour', 0),
      stop('n1', 'nice-if-convenient', 0),
    ])

    await voteExploreCandidate('trip1', grouped, 'w1', 'down')

    expect(updateDocMock).toHaveBeenCalledWith('w1', {
      priority: 'nice-if-convenient',
      rank: -1,
    })
  })

  it('crosses into an empty tier without NaN ranks', async () => {
    const grouped = groupCandidatesByPriority([stop('w1', 'worth-a-detour', 0)])

    await voteExploreCandidate('trip1', grouped, 'w1', 'up')

    expect(updateDocMock).toHaveBeenCalledWith('w1', {
      priority: 'must-see',
      rank: 0,
    })
  })

  it('does nothing above the top category, wherever in it the stop sits', async () => {
    const grouped = groupCandidatesByPriority([
      stop('m1', 'must-see', 0),
      stop('m2', 'must-see', 1),
    ])

    await voteExploreCandidate('trip1', grouped, 'm2', 'up')

    expect(updateDocMock).not.toHaveBeenCalled()
    expect(batchUpdate).not.toHaveBeenCalled()
  })

  it('does nothing below the bottom category, wherever in it the stop sits', async () => {
    const grouped = groupCandidatesByPriority([
      stop('n1', 'nice-if-convenient', 0),
      stop('n2', 'nice-if-convenient', 1),
    ])

    await voteExploreCandidate('trip1', grouped, 'n1', 'down')

    expect(updateDocMock).not.toHaveBeenCalled()
    expect(batchUpdate).not.toHaveBeenCalled()
  })

  it('ignores a stop that is not in the list at all', async () => {
    const grouped = groupCandidatesByPriority([stop('m1', 'must-see', 0)])

    await voteExploreCandidate('trip1', grouped, 'ghost', 'up')

    expect(updateDocMock).not.toHaveBeenCalled()
    expect(batchUpdate).not.toHaveBeenCalled()
  })

  // A promote followed by a demote must land the stop back where it started,
  // or repeated nudging would drift a stop through the tiers.
  it('round-trips a stop back to its original tier', async () => {
    const grouped = groupCandidatesByPriority([
      stop('m1', 'must-see', 0),
      stop('w1', 'worth-a-detour', 0),
    ])

    await voteExploreCandidate('trip1', grouped, 'w1', 'up')
    expect(updateDocMock).toHaveBeenLastCalledWith('w1', {
      priority: 'must-see',
      rank: 1,
    })

    const afterPromote = groupCandidatesByPriority([
      stop('m1', 'must-see', 0),
      stop('w1', 'must-see', 1),
    ])
    await voteExploreCandidate('trip1', afterPromote, 'w1', 'down')

    // Bottom of must-see with an empty tier below → back to worth-a-detour.
    expect(updateDocMock).toHaveBeenLastCalledWith('w1', {
      priority: 'worth-a-detour',
      rank: 0,
    })
  })
})
