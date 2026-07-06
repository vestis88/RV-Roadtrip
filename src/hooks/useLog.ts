import { useEffect, useState } from 'react'
import { collection, onSnapshot, orderBy, query } from 'firebase/firestore'
import type { LogEntry } from '@rv/shared'
import { db } from '../lib/firebase'

export type LogEntryWithId = LogEntry & { id: string }

export function useLog(tripId: string) {
  const [entries, setEntries] = useState<LogEntryWithId[]>([])

  useEffect(() => {
    const q = query(
      collection(db, 'trips', tripId, 'log'),
      orderBy('createdAt'),
    )
    const unsubscribe = onSnapshot(
      q,
      (snap) =>
        setEntries(
          snap.docs.map((d) => ({ id: d.id, ...(d.data() as LogEntry) })),
        ),
      (error) => console.error('[useLog] onSnapshot error', tripId, error),
    )
    return unsubscribe
  }, [tripId])

  return { entries }
}
