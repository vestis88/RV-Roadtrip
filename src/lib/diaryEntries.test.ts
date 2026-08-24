import { describe, expect, it, vi } from 'vitest'

const updateDocMock = vi.fn().mockResolvedValue(undefined)
const deleteDocMock = vi.fn().mockResolvedValue(undefined)
vi.mock('firebase/firestore', () => ({
  doc: (_db: unknown, ...path: string[]) => ({ path: path.join('/') }),
  updateDoc: (ref: { path: string }, data: unknown) =>
    updateDocMock(ref.path, data),
  deleteDoc: (ref: { path: string }) => deleteDocMock(ref.path),
}))
vi.mock('./firebase', () => ({ db: {} }))

const { updateDiaryEntry, deleteDiaryEntry } = await import('./diaryEntries')

/** Requested 2026-08-24: "want to be able to edit diary entries as well." */
describe('editing a diary entry', () => {
  it('writes the corrected date and note', async () => {
    updateDocMock.mockClear()
    await updateDiaryEntry('trip1', 'log1', {
      date: '2026-07-11',
      note: 'Soaked by the waterfall.',
    })
    const [path, written] = updateDocMock.mock.calls[0]
    expect(path).toBe('trips/trip1/log/log1')
    expect(written).toEqual({
      date: '2026-07-11',
      note: 'Soaked by the waterfall.',
    })
  })

  // DiaryScreen renders the note block on truthiness, so whitespace would
  // leave a blank line where the note used to be.
  it('clears a note emptied down to whitespace', async () => {
    updateDocMock.mockClear()
    await updateDiaryEntry('trip1', 'log1', { date: '2026-07-11', note: '   ' })
    const [, written] = updateDocMock.mock.calls[0]
    expect(written.note).toBe('')
  })

  /**
   * The entry says which place it is about, and repointing it would make it
   * a different entry rather than an edited one. createdAt stays as the
   * immutable record of when it was typed — which is what makes backdating
   * `date` safe.
   */
  it('never touches what the entry points at, or when it was typed', async () => {
    updateDocMock.mockClear()
    await updateDiaryEntry('trip1', 'log1', { date: '2026-07-11', note: 'x' })
    const [, written] = updateDocMock.mock.calls[0]
    expect(written).not.toHaveProperty('refPath')
    expect(written).not.toHaveProperty('refType')
    expect(written).not.toHaveProperty('createdAt')
  })

  /**
   * A real delete, not a tombstone: nothing re-proposes a diary entry, so
   * there is nothing to remember. The place keeps its own doneAt — deleting
   * a note you regret writing must not also claim you never went.
   */
  it('deletes an entry outright', async () => {
    deleteDocMock.mockClear()
    await deleteDiaryEntry('trip1', 'log1')
    expect(deleteDocMock).toHaveBeenCalledWith('trips/trip1/log/log1')
  })
})
