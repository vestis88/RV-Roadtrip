import { useRef, useState } from 'react'
import { addDoc, collection, serverTimestamp } from 'firebase/firestore'
import type { Traveler, Trip, TripSettings } from '@rv/shared'
import { ChipMultiSelect } from '../components/ChipMultiSelect'
import { PlaceAutocompleteInput } from '../components/PlaceAutocompleteInput'
import { HighlightsReviewPanel } from '../components/HighlightsReviewPanel'
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
  const [reviewBeforeGenerating, setReviewBeforeGenerating] = useState(false)
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
        createdAt: serverTimestamp(),
        ...(reviewBeforeGenerating ? { reviewHighlights: true } : {}),
      })
    } finally {
      submittingRef.current = false
      setSubmitting(false)
    }
  }

  return (
    <div className="mx-auto max-w-2xl space-y-4 p-4 text-left">
      <div className="card space-y-4 p-4">
        <h2 className="heading-md text-base">Route &amp; dates</h2>
        <div className="grid grid-cols-2 gap-4">
          <label className="block">
            <span className="field-label">Start date</span>
            <input
              type="date"
              data-testid="start-date-input"
              className="field"
              value={settings.startDate}
              onChange={(event) => commit({ startDate: event.target.value })}
            />
          </label>
          <label className="block">
            <span className="field-label">End date</span>
            <input
              type="date"
              data-testid="end-date-input"
              className="field"
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
      </div>

      <div className="card p-4">
        <h2 className="heading-md mb-3 text-base">Travelers</h2>
        <div className="space-y-2">
          {settings.travelers.map((traveler, index) => (
            <div
              key={index}
              className="surface flex flex-wrap items-center gap-2 rounded-lg p-2"
              data-testid={`traveler-row-${index}`}
            >
              <input
                className="field field-sm min-w-0 flex-1"
                data-testid={`traveler-name-${index}`}
                value={traveler.name}
                onChange={(event) =>
                  updateTraveler(index, { name: event.target.value })
                }
                placeholder="Name"
              />
              <select
                data-testid={`traveler-role-${index}`}
                className="field field-sm w-auto"
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
                  className="field field-sm w-16"
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
                className="btn btn-sm btn-danger-ghost"
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
          className="btn btn-sm btn-secondary mt-3"
        >
          Add traveler
        </button>
      </div>

      <div className="card space-y-5 p-4">
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
          <span className="field-label">
            {settings.restDayFrequency === 0
              ? 'No rest days'
              : `Rest day every ${settings.restDayFrequency} days`}
          </span>
          <input
            type="range"
            min={0}
            max={14}
            data-testid="rest-day-frequency-input"
            className="w-full accent-orange-600"
            value={settings.restDayFrequency}
            onChange={(event) =>
              commit({ restDayFrequency: Number(event.target.value) })
            }
          />
        </label>

        <label className="block">
          <span className="field-label">
            Max drive hours/day: {settings.maxDriveHoursPerDay}
          </span>
          <input
            type="range"
            min={1}
            max={10}
            data-testid="max-drive-hours-input"
            className="w-full accent-orange-600"
            value={settings.maxDriveHoursPerDay}
            onChange={(event) =>
              commit({ maxDriveHoursPerDay: Number(event.target.value) })
            }
          />
        </label>
      </div>

      <div className="card p-4">
        {(trip.planMeta.status === 'idle' ||
          trip.planMeta.status === 'stale' ||
          trip.planMeta.status === 'error') && (
          <label className="mb-3 flex cursor-pointer items-center gap-2 text-sm text-neutral-700 dark:text-neutral-300">
            <input
              type="checkbox"
              data-testid="review-highlights-checkbox"
              className="accent-orange-600"
              checked={reviewBeforeGenerating}
              onChange={(event) =>
                setReviewBeforeGenerating(event.target.checked)
              }
            />
            Review suggested regions before generating
          </label>
        )}
        <div className="flex flex-wrap items-center gap-3">
          {trip.planMeta.status === 'idle' && (
            <button
              type="button"
              data-testid="generate-plan-button"
              onClick={generatePlan}
              disabled={submitting}
              className="btn btn-primary"
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
              className="btn btn-primary"
            >
              Re-plan trip
            </button>
          )}
          {trip.planMeta.status === 'error' && (
            <button
              type="button"
              data-testid="generate-plan-button"
              onClick={generatePlan}
              disabled={submitting}
              className="btn btn-primary"
            >
              Retry
            </button>
          )}
          <span className="chip chip-neutral" data-testid="plan-status">
            {trip.planMeta.status}
          </span>
          {trip.planMeta.status === 'generating' && (
            <span
              className="text-sm text-neutral-500 dark:text-neutral-400"
              data-testid="plan-progress"
            >
              {trip.planMeta.progressTotal
                ? `${trip.planMeta.progressCurrent ?? 0}/${trip.planMeta.progressTotal} days (${Math.round(
                    ((trip.planMeta.progressCurrent ?? 0) /
                      trip.planMeta.progressTotal) *
                      100,
                  )}%)`
                : (trip.planMeta.progressLabel ?? 'planning your route…')}
            </span>
          )}
        </div>
        {trip.planMeta.status === 'error' && trip.planMeta.error && (
          <p
            className="mt-2 text-sm text-red-600 dark:text-red-400"
            data-testid="plan-error"
          >
            {trip.planMeta.error}
          </p>
        )}
      </div>

      {trip.planMeta.status === 'awaiting-highlights-review' && (
        <HighlightsReviewPanel
          tripId={tripId}
          pendingHighlights={trip.planMeta.pendingHighlights}
          startPoint={trip.settings.startPoint}
          endPoint={trip.settings.endPoint}
        />
      )}

      <p
        className="text-xs text-neutral-400 dark:text-neutral-500"
        data-testid="app-build-time"
      >
        App build: {new Date(__APP_BUILD_TIME__).toLocaleString()}
      </p>
    </div>
  )
}
