import type {
  DocumentData,
  DocumentReference,
  Firestore,
  SetOptions,
} from 'firebase-admin/firestore'

/**
 * Firestore caps a single batched write at 500 operations. Any mutation that
 * touches a whole trip's days (and their activities/restaurants
 * subcollections) can blow well past that on a real multi-week trip — a
 * single day is worth roughly 2 + 2 x (its activities + restaurants)
 * operations when both an old and new copy are involved, so every such
 * mutation in this codebase goes through commitInChunks rather than a single
 * db.batch(). 400 leaves comfortable headroom under the cap.
 */
const MAX_OPS_PER_BATCH = 400

export type PendingWrite =
  // `options` carries Firestore's own SetOptions (notably { merge: true })
  // through unchanged, so a merge-set doesn't have to bypass this machinery
  // — and thereby its 500-op chunking — just to keep its semantics.
  | {
      op: 'set'
      ref: DocumentReference
      data: DocumentData
      options?: SetOptions
    }
  | { op: 'delete'; ref: DocumentReference }

/**
 * Commits `writes` in order, split across as many WriteBatches as needed.
 *
 * Order matters and is preserved: batches are committed sequentially, so a
 * document's delete always lands before a later write to that same document
 * ID, even when the two fall in different chunks.
 */
export async function commitInChunks(
  db: Firestore,
  writes: PendingWrite[],
): Promise<void> {
  for (let i = 0; i < writes.length; i += MAX_OPS_PER_BATCH) {
    const batch = db.batch()
    for (const write of writes.slice(i, i + MAX_OPS_PER_BATCH)) {
      if (write.op === 'set') {
        if (write.options) batch.set(write.ref, write.data, write.options)
        else batch.set(write.ref, write.data)
      }
      else batch.delete(write.ref)
    }
    await batch.commit()
  }
}
