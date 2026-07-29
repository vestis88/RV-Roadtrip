import { useState } from 'react'
import { addDoc, collection } from 'firebase/firestore'
import { corridorStopSchema, type NamedPoint } from '@rv/shared'
import { db } from '../lib/firebase'
import { PlaceAutocompleteInput } from './PlaceAutocompleteInput'

interface AddCorridorStopFormProps {
  tripId: string
  defaultLocation: NamedPoint
}

/**
 * A traveler pinning a stop on the corridor directly — same
 * client-direct-write philosophy as AddCustomStopForm, writing straight to
 * `corridorStops` with no callable involved. Status starts at 'locked', not
 * 'proposed': typing a stop in here is a deliberate choice, the same reason
 * AddCustomStopForm writes `status: 'selected'` immediately rather than
 * 'suggested'. `linkedDayIds` starts empty — reconciling it into an actual
 * day is phase 4's job.
 */
export function AddCorridorStopForm({
  tripId,
  defaultLocation,
}: AddCorridorStopFormProps) {
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [location, setLocation] = useState<NamedPoint>(defaultLocation)
  const [why, setWhy] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  function reset() {
    setName('')
    setLocation(defaultLocation)
    setWhy('')
  }

  async function submit() {
    setError(null)
    if (!name.trim()) {
      setError('Name is required.')
      return
    }
    setSubmitting(true)
    try {
      const stop = corridorStopSchema.parse({
        name: name.trim(),
        lat: location.lat,
        lng: location.lng,
        ...(why.trim() ? { why: why.trim() } : {}),
        status: 'locked',
        linkedDayIds: [],
      })
      await addDoc(collection(db, 'trips', tripId, 'corridorStops'), stop)
      reset()
      setOpen(false)
    } catch (err) {
      console.error('Failed to add corridor stop', err)
      setError('Could not add stop — double check the fields and try again.')
    } finally {
      setSubmitting(false)
    }
  }

  if (!open) {
    return (
      <button
        type="button"
        data-testid="add-corridor-stop-toggle"
        onClick={() => setOpen(true)}
        className="btn btn-sm border border-dashed border-neutral-300 bg-white/95 text-neutral-600 shadow-md backdrop-blur-sm hover:bg-neutral-100 dark:border-neutral-700 dark:bg-neutral-900/95 dark:text-neutral-300 dark:hover:bg-neutral-800"
      >
        + Add stop
      </button>
    )
  }

  return (
    <div
      data-testid="add-corridor-stop-form"
      className="card w-64 space-y-2 p-3 shadow-lg"
    >
      <label className="block">
        <span className="mb-1 block text-sm font-medium text-neutral-700 dark:text-neutral-300">
          Name
        </span>
        <input
          data-testid="corridor-stop-name"
          className="field field-sm"
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="e.g. Rondane viewpoint"
        />
      </label>

      <PlaceAutocompleteInput
        label="Location"
        testId="corridor-stop-location"
        value={location}
        onChange={setLocation}
      />

      <label className="block">
        <span className="mb-1 block text-sm font-medium text-neutral-700 dark:text-neutral-300">
          Why (optional)
        </span>
        <input
          data-testid="corridor-stop-why"
          className="field field-sm"
          value={why}
          onChange={(event) => setWhy(event.target.value)}
        />
      </label>

      {error && (
        <p
          data-testid="corridor-stop-form-error"
          className="text-sm text-red-600 dark:text-red-400"
        >
          {error}
        </p>
      )}

      <div className="flex gap-2">
        <button
          type="button"
          data-testid="corridor-stop-submit"
          disabled={submitting}
          onClick={submit}
          className="btn btn-sm btn-primary"
        >
          Add stop
        </button>
        <button
          type="button"
          data-testid="corridor-stop-cancel"
          onClick={() => {
            reset()
            setOpen(false)
          }}
          className="btn btn-sm btn-secondary"
        >
          Cancel
        </button>
      </div>
    </div>
  )
}
