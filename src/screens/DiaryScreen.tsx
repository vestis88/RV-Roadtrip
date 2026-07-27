import { useEffect, useState } from 'react'
import { doc, getDoc } from 'firebase/firestore'
import { useTripContext } from '../context/TripContext'
import { useLog, type LogEntryWithId } from '../hooks/useLog'
import { db } from '../lib/firebase'

function DiaryEntryRow({ entry }: { entry: LogEntryWithId }) {
  const [name, setName] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    getDoc(doc(db, entry.refPath))
      .then((snap) => {
        if (!cancelled) setName((snap.data()?.name as string) ?? entry.refPath)
      })
      .catch((error: unknown) => {
        console.error('[DiaryEntryRow] failed to resolve place', error)
        if (!cancelled) setName(entry.refPath)
      })
    return () => {
      cancelled = true
    }
  }, [entry.refPath])

  return (
    <li className="card p-3" data-testid="diary-entry">
      <p className="text-sm font-semibold text-neutral-900 dark:text-white">
        {name ?? '…'}
      </p>
      <p className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-neutral-500 dark:text-neutral-400">
        <span>{entry.date}</span>
        <span className="chip chip-blue">{entry.refType}</span>
      </p>
      {entry.note && (
        <p
          className="mt-1 text-sm text-neutral-700 dark:text-neutral-300"
          data-testid="diary-entry-note"
        >
          {entry.note}
        </p>
      )}
    </li>
  )
}

export function DiaryScreen() {
  const { tripId } = useTripContext()
  const { entries } = useLog(tripId)

  function exportDiary() {
    const text = entries
      .map(
        (entry) =>
          `${entry.date} — ${entry.refType}${entry.note ? `: ${entry.note}` : ''}`,
      )
      .join('\n')

    if (navigator.share) {
      navigator.share({ title: 'Trip diary', text }).catch(() => {
        // user cancelled the share sheet — nothing to do
      })
      return
    }

    const blob = new Blob([text], { type: 'text/plain' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = 'trip-diary.txt'
    link.click()
    URL.revokeObjectURL(url)
  }

  return (
    <div className="mx-auto max-w-2xl p-4 text-left">
      <div className="mb-4 flex items-center justify-between gap-3">
        <h2 className="heading-md">Diary</h2>
        <button
          type="button"
          data-testid="diary-export"
          onClick={exportDiary}
          className="btn btn-sm btn-secondary"
        >
          Export
        </button>
      </div>

      {entries.length === 0 ? (
        <p
          className="text-neutral-500 dark:text-neutral-400"
          data-testid="diary-empty"
        >
          Nothing logged yet — mark a card Done to add it here.
        </p>
      ) : (
        <ul className="space-y-2" data-testid="diary-list">
          {entries.map((entry) => (
            <DiaryEntryRow key={entry.id} entry={entry} />
          ))}
        </ul>
      )}
    </div>
  )
}

export default DiaryScreen
