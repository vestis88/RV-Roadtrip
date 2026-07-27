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
    <div className="mx-auto max-w-2xl p-4 text-left">
      <div className="card space-y-1 p-4">
        <label className="block">
          <span className="field-label">Notes</span>
          <textarea
            data-testid="notes-textarea"
            className="field h-40 resize-y"
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
    </div>
  )
}
