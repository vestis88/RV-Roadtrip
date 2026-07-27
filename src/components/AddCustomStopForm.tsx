import { useState } from 'react'
import { addDoc, collection, doc } from 'firebase/firestore'
import {
  activitySchema,
  restaurantSchema,
  type ActivityCategory,
  type Meal,
  type NamedPoint,
} from '@rv/shared'
import { db } from '../lib/firebase'
import { PlaceAutocompleteInput } from './PlaceAutocompleteInput'

interface AddCustomStopFormProps {
  tripId: string
  dayId: string
  defaultLocation: NamedPoint
}

const ACTIVITY_CATEGORIES: ActivityCategory[] = [
  'sight',
  'hike',
  'museum',
  'beach',
  'playground',
  'other',
]

const MEALS: Meal[] = ['breakfast', 'lunch', 'dinner']

export function AddCustomStopForm({
  tripId,
  dayId,
  defaultLocation,
}: AddCustomStopFormProps) {
  const [open, setOpen] = useState(false)
  const [kind, setKind] = useState<'activity' | 'restaurant'>('activity')
  const [name, setName] = useState('')
  const [location, setLocation] = useState<NamedPoint>(defaultLocation)
  const [category, setCategory] = useState<ActivityCategory>('sight')
  const [kidFriendly, setKidFriendly] = useState(false)
  const [meal, setMeal] = useState<Meal>('lunch')
  const [cuisine, setCuisine] = useState('')
  const [blurb, setBlurb] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  function reset() {
    setName('')
    setLocation(defaultLocation)
    setCategory('sight')
    setKidFriendly(false)
    setMeal('lunch')
    setCuisine('')
    setBlurb('')
  }

  async function submit() {
    setError(null)
    if (!name.trim() || !blurb.trim()) {
      setError('Name and description are both required.')
      return
    }
    setSubmitting(true)
    try {
      const dayRef = doc(db, 'trips', tripId, 'days', dayId)
      if (kind === 'activity') {
        const activity = activitySchema.parse({
          name: name.trim(),
          category,
          lat: location.lat,
          lng: location.lng,
          blurb: blurb.trim(),
          kidFriendly,
          status: 'selected',
        })
        await addDoc(collection(dayRef, 'activities'), activity)
      } else {
        const restaurant = restaurantSchema.parse({
          name: name.trim(),
          meal,
          lat: location.lat,
          lng: location.lng,
          blurb: blurb.trim(),
          ...(cuisine.trim() ? { cuisine: cuisine.trim() } : {}),
          status: 'selected',
        })
        await addDoc(collection(dayRef, 'restaurants'), restaurant)
      }
      reset()
      setOpen(false)
    } catch (err) {
      console.error('Failed to add custom stop', err)
      setError('Could not add stop — double check the fields and try again.')
    } finally {
      setSubmitting(false)
    }
  }

  if (!open) {
    return (
      <div className="mx-4 mt-4">
        <button
          type="button"
          data-testid="add-custom-stop-toggle"
          onClick={() => setOpen(true)}
          className="rounded border border-dashed border-neutral-300 px-3 py-1.5 text-sm text-neutral-600 dark:border-neutral-700 dark:text-neutral-300"
        >
          + Add custom stop
        </button>
      </div>
    )
  }

  return (
    <div
      data-testid="add-custom-stop-form"
      className="mx-4 mt-4 space-y-3 rounded border border-neutral-200 p-3 dark:border-neutral-800"
    >
      <div className="flex gap-2 text-sm">
        <button
          type="button"
          data-testid="custom-stop-kind-activity"
          onClick={() => setKind('activity')}
          className={`rounded px-2 py-1 ${kind === 'activity' ? 'bg-orange-600 text-white' : 'border border-neutral-300 text-neutral-900 dark:border-neutral-700 dark:text-white'}`}
        >
          Activity
        </button>
        <button
          type="button"
          data-testid="custom-stop-kind-restaurant"
          onClick={() => setKind('restaurant')}
          className={`rounded px-2 py-1 ${kind === 'restaurant' ? 'bg-orange-600 text-white' : 'border border-neutral-300 text-neutral-900 dark:border-neutral-700 dark:text-white'}`}
        >
          Restaurant
        </button>
      </div>

      <label className="block">
        <span className="mb-1 block text-sm font-medium text-neutral-700 dark:text-neutral-300">
          Name
        </span>
        <input
          data-testid="custom-stop-name"
          className="w-full rounded border border-neutral-300 px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-800 dark:text-white"
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="e.g. Sjoa river rafting"
        />
      </label>

      <PlaceAutocompleteInput
        label="Location"
        testId="custom-stop-location"
        value={location}
        onChange={setLocation}
      />

      {kind === 'activity' ? (
        <div className="flex flex-wrap items-center gap-3">
          <label className="block">
            <span className="mb-1 block text-sm font-medium text-neutral-700 dark:text-neutral-300">
              Category
            </span>
            <select
              data-testid="custom-stop-category"
              className="rounded border border-neutral-300 px-2 py-1 text-sm dark:border-neutral-700 dark:bg-neutral-800 dark:text-white"
              value={category}
              onChange={(event) =>
                setCategory(event.target.value as ActivityCategory)
              }
            >
              {ACTIVITY_CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </label>
          <label className="flex items-center gap-1 text-sm text-neutral-700 dark:text-neutral-300">
            <input
              type="checkbox"
              data-testid="custom-stop-kid-friendly"
              checked={kidFriendly}
              onChange={(event) => setKidFriendly(event.target.checked)}
            />
            Kid-friendly
          </label>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-3">
          <label className="block">
            <span className="mb-1 block text-sm font-medium text-neutral-700 dark:text-neutral-300">
              Meal
            </span>
            <select
              data-testid="custom-stop-meal"
              className="rounded border border-neutral-300 px-2 py-1 text-sm dark:border-neutral-700 dark:bg-neutral-800 dark:text-white"
              value={meal}
              onChange={(event) => setMeal(event.target.value as Meal)}
            >
              {MEALS.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="mb-1 block text-sm font-medium text-neutral-700 dark:text-neutral-300">
              Cuisine (optional)
            </span>
            <input
              data-testid="custom-stop-cuisine"
              className="rounded border border-neutral-300 px-2 py-1 text-sm dark:border-neutral-700 dark:bg-neutral-800 dark:text-white"
              value={cuisine}
              onChange={(event) => setCuisine(event.target.value)}
            />
          </label>
        </div>
      )}

      <label className="block">
        <span className="mb-1 block text-sm font-medium text-neutral-700 dark:text-neutral-300">
          One-sentence description
        </span>
        <input
          data-testid="custom-stop-blurb"
          className="w-full rounded border border-neutral-300 px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-800 dark:text-white"
          value={blurb}
          onChange={(event) => setBlurb(event.target.value)}
          placeholder="Why it's worth the stop"
        />
      </label>

      {error && (
        <p
          data-testid="custom-stop-error"
          className="text-sm text-red-600 dark:text-red-400"
        >
          {error}
        </p>
      )}

      <div className="flex gap-2">
        <button
          type="button"
          data-testid="custom-stop-submit"
          disabled={submitting}
          onClick={submit}
          className="rounded bg-orange-600 px-3 py-1.5 text-sm text-white disabled:opacity-50"
        >
          Add stop
        </button>
        <button
          type="button"
          data-testid="custom-stop-cancel"
          onClick={() => {
            reset()
            setOpen(false)
          }}
          className="rounded border border-neutral-300 px-3 py-1.5 text-sm text-neutral-900 dark:border-neutral-700 dark:text-white"
        >
          Cancel
        </button>
      </div>
    </div>
  )
}
