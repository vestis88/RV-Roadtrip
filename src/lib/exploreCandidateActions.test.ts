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
  it('swaps ranks with the neighbour above when moving up inside a tier', async () => {
    const grouped = groupCandidatesByPriority([
      stop('a', 'must-see', 0),
      stop('b', 'must-see', 1),
    ])

    await voteExploreCandidate('trip1', grouped, 'b', 'up')

    expect(batchUpdate).toHaveBeenCalledWith('b', { rank: 0 })
    expect(batchUpdate).toHaveBeenCalledWith('a', { rank: 1 })
    expect(updateDocMock).not.toHaveBeenCalled()
  })

  it('swaps ranks with the neighbour below when moving down inside a tier', async () => {
    const grouped = groupCandidatesByPriority([
      stop('a', 'must-see', 0),
      stop('b', 'must-see', 1),
    ])

    await voteExploreCandidate('trip1', grouped, 'a', 'down')

    expect(batchUpdate).toHaveBeenCalledWith('a', { rank: 1 })
    expect(batchUpdate).toHaveBeenCalledWith('b', { rank: 0 })
  })

  // The reported bug: at a tier edge both buttons were dead, so a stop could
  // never change priority at all.
  it('promotes into the tier above when already at the top of its own tier', async () => {
    const grouped = groupCandidatesByPriority([
      stop('m1', 'must-see', 0),
      stop('m2', 'must-see', 1),
      stop('w1', 'worth-a-detour', 0),
    ])

    await voteExploreCandidate('trip1', grouped, 'w1', 'up')

    // Enters must-see at its bottom edge — one position up in the flattened
    // list, not a leap to the very top.
    expect(updateDocMock).toHaveBeenCalledWith('w1', {
      priority: 'must-see',
      rank: 2,
    })
    expect(batchUpdate).not.toHaveBeenCalled()
  })

  it('demotes into the tier below when already at the bottom of its own tier', async () => {
    const grouped = groupCandidatesByPriority([
      stop('m1', 'must-see', 0),
      stop('w1', 'worth-a-detour', 0),
      stop('w2', 'worth-a-detour', 1),
    ])

    await voteExploreCandidate('trip1', grouped, 'm1', 'down')

    // Enters worth-a-detour at its top edge.
    expect(updateDocMock).toHaveBeenCalledWith('m1', {
      priority: 'worth-a-detour',
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

  it('does nothing at the very top of the whole list', async () => {
    const grouped = groupCandidatesByPriority([stop('m1', 'must-see', 0)])

    await voteExploreCandidate('trip1', grouped, 'm1', 'up')

    expect(updateDocMock).not.toHaveBeenCalled()
    expect(batchUpdate).not.toHaveBeenCalled()
  })

  it('does nothing at the very bottom of the whole list', async () => {
    const grouped = groupCandidatesByPriority([stop('n1', 'nice-if-convenient', 0)])

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
