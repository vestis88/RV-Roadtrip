import { useEffect, useState } from 'react'
import { doc, getDoc } from 'firebase/firestore'
import { useTripContext } from '../context/TripContext'
import { useLog, type LogEntryWithId } from '../hooks/useLog'
import { db } from '../lib/firebase'
import { deleteDiaryEntry, updateDiaryEntry } from '../lib/diaryEntries'

/**
 * One entry, readable by default and editable on request.
 *
 * Requested 2026-08-24: "Also want to be able to edit diary entries as
 * well." Editing is behind a button rather than inline for the same reason
 * the done form on a stop card is: the diary is mostly read, and a screen of
 * date pickers and textareas is a worse diary than a screen of sentences.
 */
function DiaryEntryRow({
  tripId,
  entry,
}: {
  tripId: string
  entry: LogEntryWithId
}) {
  const [name, setName] = useState<string | null>(null)
  const [editing, setEditing] = useState(false)
  const [date, setDate] = useState(entry.date)
  const [note, setNote] = useState(entry.note ?? '')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [confirmingDelete, setConfirmingDelete] = useState(false)

  async function save() {
    // The diary groups by date, so an emptied one would file the entry
    // nowhere. Refused rather than silently defaulted to today, which would
    // move an entry the traveler was in the middle of correcting.
    if (!date) {
      setError('An entry needs a date.')
      return
    }
    setError(null)
    setSaving(true)
    try {
      await updateDiaryEntry(tripId, entry.id, { date, note })
      setEditing(false)
    } catch (saveError) {
      console.error('Saving a diary entry failed', saveError)
      setError('Could not save that — please try again.')
    } finally {
      setSaving(false)
    }
  }

  async function remove() {
    setError(null)
    setSaving(true)
    try {
      await deleteDiaryEntry(tripId, entry.id)
    } catch (deleteError) {
      console.error('Deleting a diary entry failed', deleteError)
      setError('Could not delete that — please try again.')
      setSaving(false)
    }
  }

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
      {editing ? (
        <div className="mt-2 space-y-1.5" data-testid="diary-entry-form">
          <input
            type="date"
            data-testid="diary-entry-date-input"
            aria-label="Date"
            className="field field-sm"
            value={date}
            onChange={(event) => setDate(event.target.value)}
          />
          <textarea
            data-testid="diary-entry-note-input"
            aria-label="Note"
            rows={3}
            className="field field-sm"
            placeholder="What happened?"
            value={note}
            onChange={(event) => setNote(event.target.value)}
          />
          <div className="flex flex-wrap gap-1.5">
            <button
              type="button"
              data-testid="diary-entry-save"
              className="btn btn-sm btn-primary"
              disabled={saving}
              onClick={() => void save()}
            >
              {saving ? 'Saving…' : 'Save'}
            </button>
            <button
              type="button"
              data-testid="diary-entry-cancel"
              className="btn btn-sm btn-outline"
              disabled={saving}
              onClick={() => {
                // Back to what is stored, not to whatever was half-typed.
                setDate(entry.date)
                setNote(entry.note ?? '')
                setError(null)
                setEditing(false)
              }}
            >
              Cancel
            </button>
            {/* Two taps, because this is the only destructive action on the
              * screen and the entry is often the only record that the day
              * happened at all. */}
            {confirmingDelete ? (
              <button
                type="button"
                data-testid="diary-entry-delete-confirm"
                className="btn btn-sm btn-danger-ghost"
                disabled={saving}
                onClick={() => void remove()}
              >
                Really delete
              </button>
            ) : (
              <button
                type="button"
                data-testid="diary-entry-delete"
                className="btn btn-sm btn-danger-ghost"
                disabled={saving}
                onClick={() => setConfirmingDelete(true)}
              >
                Delete
              </button>
            )}
          </div>
          {error && (
            <p
              data-testid="diary-entry-error"
              className="text-sm text-red-600 dark:text-red-400"
            >
              {error}
            </p>
          )}
        </div>
      ) : (
        <>
          <p className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-neutral-500 dark:text-neutral-400">
            <span>{entry.date}</span>
            <span className="chip chip-neutral">{entry.refType}</span>
            <button
              type="button"
              data-testid="diary-entry-edit"
              className="link text-xs"
              onClick={() => setEditing(true)}
            >
              Edit
            </button>
          </p>
          {entry.note && (
            <p
              className="mt-1 text-sm text-neutral-700 dark:text-neutral-300"
              data-testid="diary-entry-note"
            >
              {entry.note}
            </p>
          )}
        </>
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
          Nothing logged yet. Press &ldquo;We&rsquo;ve done this&rdquo; on a
          stop on the Map, or Done on a place inside a day, and it lands here
          with the date you give it.
        </p>
      ) : (
        <ul className="space-y-2" data-testid="diary-list">
          {entries.map((entry) => (
            <DiaryEntryRow key={entry.id} tripId={tripId} entry={entry} />
          ))}
        </ul>
      )}
    </div>
  )
}

export default DiaryScreen
