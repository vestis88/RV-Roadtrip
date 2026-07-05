import { useRef, useState } from 'react'
import { doc, updateDoc } from 'firebase/firestore'
import type { Trip } from '@rv/shared'
import { db } from '../lib/firebase'

interface NotesScreenProps {
  tripId: string
  trip: Trip
}

const AUTOSAVE_DELAY_MS = 800

export function NotesScreen({ tripId, trip }: NotesScreenProps) {
  const [text, setText] = useState(trip.notes.freeText)
  const [syncedUpdatedAt, setSyncedUpdatedAt] = useState(trip.notes.updatedAt)
  const [isEditing, setIsEditing] = useState(false)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  if (!isEditing && trip.notes.updatedAt !== syncedUpdatedAt) {
    setSyncedUpdatedAt(trip.notes.updatedAt)
    setText(trip.notes.freeText)
  }

  function scheduleSave(nextText: string) {
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = setTimeout(() => {
      updateDoc(doc(db, 'trips', tripId), {
        'notes.freeText': nextText,
        'notes.updatedAt': new Date().toISOString(),
      }).catch((error: unknown) => console.error('Failed to save notes', error))
    }, AUTOSAVE_DELAY_MS)
  }

  return (
    <div className="mx-auto max-w-2xl space-y-1 p-4 text-left">
      <label className="block">
        <span className="mb-1 block text-sm font-medium text-neutral-700 dark:text-neutral-300">
          Notes
        </span>
        <textarea
          data-testid="notes-textarea"
          className="h-40 w-full rounded border border-neutral-300 px-3 py-2 dark:border-neutral-700 dark:bg-neutral-800 dark:text-white"
          value={text}
          onFocus={() => setIsEditing(true)}
          onChange={(event) => {
            setText(event.target.value)
            scheduleSave(event.target.value)
          }}
          onBlur={() => setIsEditing(false)}
          placeholder="Anything here is read by the planner on every generation — allergies, must-sees, driving preferences…"
        />
      </label>
      <p
        className="text-xs text-neutral-500 dark:text-neutral-400"
        data-testid="notes-updated-at"
      >
        Last updated: {new Date(trip.notes.updatedAt).toLocaleString()}
      </p>
    </div>
  )
}
