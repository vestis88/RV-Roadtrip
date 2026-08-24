import { deleteDoc, doc, updateDoc } from 'firebase/firestore'
import { db } from './firebase'

/**
 * Editing what the diary already holds.
 *
 * Requested 2026-08-24: *"Also want to be able to edit diary entries as
 * well."* Until now an entry was write-once — `markDone` and `markStopDone`
 * created it and nothing could touch it again, so a typo, a wrong date or a
 * note written in a hurry at a campsite was permanent.
 *
 * Only two fields are editable, and the omissions are deliberate:
 *
 *  - `date` — the day it happened, which is also the diary's grouping key.
 *  - `note` — what the traveler wrote.
 *
 * `refPath` and `refType` are NOT editable: they say which place this entry
 * is about, and an entry repointed at a different place is a new entry, not
 * an edited one. `createdAt` is not editable either — it is the immutable
 * record of when the entry was typed, and the whole reason `date` can be
 * backdated safely (see markStopDone).
 */
export async function updateDiaryEntry(
  tripId: string,
  entryId: string,
  changes: { date: string; note: string },
): Promise<void> {
  await updateDoc(doc(db, 'trips', tripId, 'log', entryId), {
    date: changes.date,
    // Cleared rather than stored empty: DiaryScreen renders the note block on
    // truthiness, and an empty string would leave a blank line behind where
    // the note used to be.
    note: changes.note.trim(),
  })
}

/**
 * Deleting one outright.
 *
 * A real delete, not a tombstone — unlike a rejected corridor stop, nothing
 * re-proposes a diary entry, so there is nothing to remember. The place it
 * pointed at keeps its own `doneAt`; undoing THAT is the card's job (see
 * unmarkStopDone), and the two are separate on purpose: deleting a note you
 * regret writing should not also claim you never went.
 */
export async function deleteDiaryEntry(
  tripId: string,
  entryId: string,
): Promise<void> {
  await deleteDoc(doc(db, 'trips', tripId, 'log', entryId))
}
