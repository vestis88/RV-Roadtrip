import { useRef, useState } from 'react'
import { addDoc, collection } from 'firebase/firestore'
import type { Traveler, Trip, TripSettings } from '@rv/shared'
import { ChipMultiSelect } from '../components/ChipMultiSelect'
import { PlaceAutocompleteInput } from '../components/PlaceAutocompleteInput'
import { EUROPEAN_COUNTRIES } from '../lib/countries'
import { db } from '../lib/firebase'
import { PRESET_INTERESTS } from '../lib/interests'
import { updateTripSettings } from '../lib/updateTripSettings'

interface SettingsScreenProps {
  tripId: string
  trip: Trip
}

export function SettingsScreen({ tripId, trip }: SettingsScreenProps) {
  const [settings, setSettings] = useState<TripSettings>(trip.settings)
  const [submitting, setSubmitting] = useState(false)
  const submittingRef = useRef(false)

  function commit(partial: Partial<TripSettings>) {
    setSettings((prev) => ({ ...prev, ...partial }))
    updateTripSettings(tripId, partial).catch((error: unknown) =>
      console.error('Failed to save settings', error),
    )
  }

  function updateTraveler(index: number, patch: Partial<Traveler>) {
    commit({
      travelers: settings.travelers.map((traveler, i) =>
        i === index ? { ...traveler, ...patch } : traveler,
      ),
    })
  }

  function addTraveler() {
    commit({
      travelers: [...settings.travelers, { name: '', role: 'adult' }],
    })
  }

  function removeTraveler(index: number) {
    commit({ travelers: settings.travelers.filter((_, i) => i !== index) })
  }

  async function generatePlan(event: React.MouseEvent<HTMLButtonElement>) {
    // Debounce guard: rapid clicks can fire faster than React re-renders a
    // `disabled` prop, and faster than the Firestore round-trip that flips
    // trip.planMeta.status away from idle/stale (which is what normally
    // hides this button) — so disable the actual DOM node synchronously,
    // in the same tick as the click, rather than waiting on a render.
    const button = event.currentTarget
    if (submittingRef.current || button.disabled) return
    submittingRef.current = true
    button.disabled = true
    setSubmitting(true)
    try {
      await addDoc(collection(db, 'planRequests'), {
        tripId,
        kind: 'full',
        status: 'pending',
      })
    } finally {
      submittingRef.current = false
      setSubmitting(false)
    }
  }

  return (
    <div className="mx-auto max-w-2xl space-y-6 p-4 text-left">
      <div className="grid grid-cols-2 gap-4">
        <label className="block">
          <span className="mb-1 block text-sm font-medium text-neutral-700 dark:text-neutral-300">
            Start date
          </span>
          <input
            type="date"
            data-testid="start-date-input"
            className="w-full rounded border border-neutral-300 px-3 py-2 dark:border-neutral-700 dark:bg-neutral-800 dark:text-white"
            value={settings.startDate}
            onChange={(event) => commit({ startDate: event.target.value })}
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-sm font-medium text-neutral-700 dark:text-neutral-300">
            End date
          </span>
          <input
            type="date"
            data-testid="end-date-input"
            className="w-full rounded border border-neutral-300 px-3 py-2 dark:border-neutral-700 dark:bg-neutral-800 dark:text-white"
            value={settings.endDate}
            onChange={(event) => commit({ endDate: event.target.value })}
          />
        </label>
      </div>

      <PlaceAutocompleteInput
        label="Start point"
        testId="start-point-input"
        value={settings.startPoint}
        onChange={(startPoint) => commit({ startPoint })}
      />
      <PlaceAutocompleteInput
        label="Finish point"
        testId="end-point-input"
        value={settings.endPoint}
        onChange={(endPoint) => commit({ endPoint })}
      />

      <div>
        <h2 className="mb-2 text-sm font-medium text-neutral-700 dark:text-neutral-300">
          Travelers
        </h2>
        <div className="space-y-2">
          {settings.travelers.map((traveler, index) => (
            <div
              key={index}
              className="flex flex-wrap items-center gap-2"
              data-testid={`traveler-row-${index}`}
            >
              <input
                className="min-w-0 flex-1 rounded border border-neutral-300 px-2 py-1 text-sm dark:border-neutral-700 dark:bg-neutral-800 dark:text-white"
                data-testid={`traveler-name-${index}`}
                value={traveler.name}
                onChange={(event) =>
                  updateTraveler(index, { name: event.target.value })
                }
                placeholder="Name"
              />
              <select
                data-testid={`traveler-role-${index}`}
                className="rounded border border-neutral-300 px-2 py-1 text-sm dark:border-neutral-700 dark:bg-neutral-800 dark:text-white"
                value={traveler.role}
                onChange={(event) =>
                  updateTraveler(index, {
                    role: event.target.value as 'adult' | 'child',
                  })
                }
              >
                <option value="adult">Adult</option>
                <option value="child">Child</option>
              </select>
              {traveler.role === 'child' && (
                <input
                  type="number"
                  min={0}
                  data-testid={`traveler-age-${index}`}
                  className="w-16 rounded border border-neutral-300 px-2 py-1 text-sm dark:border-neutral-700 dark:bg-neutral-800 dark:text-white"
                  value={traveler.age ?? ''}
                  onChange={(event) =>
                    updateTraveler(index, {
                      age: Number(event.target.value) || 0,
                    })
                  }
                  placeholder="Age"
                />
              )}
              <button
                type="button"
                data-testid={`traveler-remove-${index}`}
                onClick={() => removeTraveler(index)}
                className="text-sm text-red-600 dark:text-red-400"
              >
                Remove
              </button>
            </div>
          ))}
        </div>
        <button
          type="button"
          data-testid="traveler-add"
          onClick={addTraveler}
          className="mt-2 rounded border border-neutral-300 px-3 py-1 text-sm text-neutral-900 dark:border-neutral-700 dark:text-white"
        >
          Add traveler
        </button>
      </div>

      <ChipMultiSelect
        label="Interests"
        testIdPrefix="interest"
        options={PRESET_INTERESTS.map((value) => ({ value, label: value }))}
        selected={settings.interests}
        onChange={(interests) => commit({ interests })}
        allowFreeEntry
      />

      <ChipMultiSelect
        label="Preferred countries"
        testIdPrefix="country"
        options={EUROPEAN_COUNTRIES.map((country) => ({
          value: country.code,
          label: country.name,
        }))}
        selected={settings.preferredCountries}
        onChange={(preferredCountries) => commit({ preferredCountries })}
      />

      <label className="block">
        <span className="mb-1 block text-sm font-medium text-neutral-700 dark:text-neutral-300">
          {settings.restDayFrequency === 0
            ? 'No rest days'
            : `Rest day every ${settings.restDayFrequency} days`}
        </span>
        <input
          type="range"
          min={0}
          max={14}
          data-testid="rest-day-frequency-input"
          value={settings.restDayFrequency}
          onChange={(event) =>
            commit({ restDayFrequency: Number(event.target.value) })
          }
        />
      </label>

      <label className="block">
        <span className="mb-1 block text-sm font-medium text-neutral-700 dark:text-neutral-300">
          Max drive hours/day: {settings.maxDriveHoursPerDay}
        </span>
        <input
          type="range"
          min={1}
          max={10}
          data-testid="max-drive-hours-input"
          value={settings.maxDriveHoursPerDay}
          onChange={(event) =>
            commit({ maxDriveHoursPerDay: Number(event.target.value) })
          }
        />
      </label>

      <div className="flex items-center gap-3">
        {trip.planMeta.status === 'idle' && (
          <button
            type="button"
            data-testid="generate-plan-button"
            onClick={generatePlan}
            disabled={submitting}
            className="rounded bg-orange-600 px-4 py-2 text-white disabled:opacity-50"
          >
            Generate plan
          </button>
        )}
        {trip.planMeta.status === 'stale' && (
          <button
            type="button"
            data-testid="generate-plan-button"
            onClick={generatePlan}
            disabled={submitting}
            className="rounded bg-orange-600 px-4 py-2 text-white disabled:opacity-50"
          >
            Re-plan trip
          </button>
        )}
        <span
          className="text-sm text-neutral-500 dark:text-neutral-400"
          data-testid="plan-status"
        >
          {trip.planMeta.status}
        </span>
      </div>
    </div>
  )
}
