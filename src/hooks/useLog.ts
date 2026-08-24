import { useEffect, useState } from 'react'
import { collection, onSnapshot, orderBy, query } from 'firebase/firestore'
import type { LogEntry } from '@rv/shared'
import { db } from '../lib/firebase'

export type LogEntryWithId = LogEntry & { id: string }

/**
 * Diary order: when it HAPPENED, then when it was typed.
 *
 * Requested 2026-08-24: "Dairy should be chronologically ordered."
 *
 * The query alone ordered by `createdAt`, which is when the entry was
 * written down. That was the same thing as chronological right up until the
 * moment happened-at became editable earlier the same day — so a stop logged
 * three days late landed at the bottom of the diary instead of on its own
 * day, which is exactly the case backdating exists for.
 *
 * Sorted here rather than in the query because ordering by two fields needs
 * a composite index (`firestore.indexes.json` is empty, and deploying one
 * for a collection of a few dozen documents is not a trade worth making).
 *
 * `createdAt` breaks ties because `date` is a calendar day with no time in
 * it, so two things done on the same day can only be ordered by when they
 * were written down. Oldest first: a diary reads forwards.
 */
function byWhenItHappened(a: LogEntryWithId, b: LogEntryWithId): number {
  if (a.date !== b.date) return a.date < b.date ? -1 : 1
  return a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0
}

export function useLog(tripId: string) {
  const [entries, setEntries] = useState<LogEntryWithId[]>([])

  useEffect(() => {
    // Ordered by `createdAt` at the query, then re-sorted below. The server
    // order is only a stable starting point — see byWhenItHappened.
    const q = query(
      collection(db, 'trips', tripId, 'log'),
      orderBy('createdAt'),
    )
    const unsubscribe = onSnapshot(
      q,
      (snap) =>
        setEntries(
          snap.docs
            .map((d) => ({ id: d.id, ...(d.data() as LogEntry) }))
            .sort(byWhenItHappened),
        ),
      (error) => console.error('[useLog] onSnapshot error', tripId, error),
    )
    return unsubscribe
  }, [tripId])

  return { entries }
}
