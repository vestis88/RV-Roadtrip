import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import type { Traveler, Trip, TripSettings } from '@rv/shared'
import { ChipMultiSelect } from '../components/ChipMultiSelect'
import { ConfirmGenerateDialog } from '../components/ConfirmGenerateDialog'
import { PlaceAutocompleteInput } from '../components/PlaceAutocompleteInput'
import { EUROPEAN_COUNTRIES } from '../lib/countries'
import { PRESET_INTERESTS } from '../lib/interests'
import { mergeRemoteSettings } from '../lib/mergeRemoteSettings'
import { generateExploreHighlights } from '../lib/exploreCandidateActions'
import { submitPlanRequest } from '../lib/submitPlanRequest'
import { updateTripSettings } from '../lib/updateTripSettings'
import { hasRoute } from '../lib/validateRoute'

interface SettingsScreenProps {
  tripId: string
  trip: Trip
}

const GENERATE_LABEL: Record<'idle' | 'stale' | 'error', string> = {
  idle: 'Generate full plan',
  stale: 'Re-plan trip',
  error: 'Retry',
}

export function SettingsScreen({ tripId, trip }: SettingsScreenProps) {
  const navigate = useNavigate()
  const [settings, setSettings] = useState<TripSettings>(trip.settings)
  const [submitting, setSubmitting] = useState(false)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [overviewSubmitting, setOverviewSubmitting] = useState(false)
  const [overviewError, setOverviewError] = useState<string | null>(null)
  // Shared between "Generate overview" and "Generate full plan" — see
  // hasRoute's own doc comment for why this check exists.
  const [routeError, setRouteError] = useState<string | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)
  // `overviewSubmitting` alone only tracks *this* call, made from *this*
  // mount of the component — navigating away and back (e.g. tapping the
  // Map tab mid-generation, out of curiosity or impatience) remounts
  // SettingsScreen with that state reset to false, making an actually
  // still-running generation look like it silently stopped or got
  // "disabled." `trip.planMeta.exploreStatus` is the real, server-side
  // truth (the same field ExploreMapScreen's own busy state should — and
  // now does — read too), so it survives navigation and stays accurate
  // regardless of which screen fired the call.
  const exploring = overviewSubmitting || trip.planMeta.exploreStatus === 'generating'

  // Switching trips (TripSwitcher) doesn't remount this component — it's
  // the same SettingsScreen instance re-rendered with new tripId/trip
  // props, and `useState(trip.settings)` above only reads its initial
  // value once, on first mount. Without this resync, every subsequent
  // trip switch kept showing whichever trip's settings this component
  // happened to mount with — reported as switching trips "erasing" travel
  // dates and destinations (really: displaying a *different* trip's dates,
  // possibly blank ones, instead of the one just switched to). Same
  // render-time resync pattern NotesScreen.tsx already uses for its own
  // local text state, keyed on tripId here since TripSettings has no
  // per-edit watermark the way notes.updatedAt gives NotesScreen.
  const [syncedTripId, setSyncedTripId] = useState(tripId)
  // Fields edited during this mount; the server copy never overwrites them
  // (see mergeRemoteSettings). Reset on a trip switch, since those edits
  // belong to the trip being switched away from.
  const [dirtyKeys, setDirtyKeys] = useState<ReadonlySet<keyof TripSettings>>(
    () => new Set(),
  )
  // Every snapshot of the trip doc hands us a brand-new object, including
  // ones triggered by something entirely unrelated to settings (planMeta
  // ticking over during a generation, say) — so this only tracks *which*
  // remote copy has already been folded in; mergeRemoteSettings decides
  // whether any of it actually differs.
  const [syncedSettings, setSyncedSettings] = useState(trip.settings)
  if (tripId !== syncedTripId) {
    setSyncedTripId(tripId)
    setSyncedSettings(trip.settings)
    setDirtyKeys(new Set())
    setSettings(trip.settings)
  } else if (trip.settings !== syncedSettings) {
    setSyncedSettings(trip.settings)
    setSettings((prev) => mergeRemoteSettings(prev, trip.settings, dirtyKeys))
  }

  function commit(partial: Partial<TripSettings>) {
    setDirtyKeys((prev) => {
      const next = new Set(prev)
      for (const key of Object.keys(partial) as (keyof TripSettings)[]) {
        next.add(key)
      }
      return next
    })
    setSettings((prev) => ({ ...prev, ...partial }))
    setSaveError(null)
    updateTripSettings(tripId, partial, trip.planMeta.status).catch(
      (error: unknown) => {
        // The optimistic local update above stays on screen either way, and
        // the render-time resync only re-reads on a trip switch — so a
        // failed write used to leave the field showing a value that was
        // never persisted, with only a console line to show for it. The
        // traveler would then generate against settings they believed they
        // had changed.
        console.error('Failed to save settings', error)
        setSaveError('Could not save that change — check your connection.')
      },
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

  async function confirmGeneratePlan() {
    setSubmitting(true)
    try {
      await submitPlanRequest(tripId, 'full')
      setConfirmOpen(false)
    } catch (error) {
      // Previously uncaught: the rejection went unhandled, the dialog stayed
      // open, and nothing said the request hadn't been made.
      console.error('submitPlanRequest failed', error)
      setOverviewError('Could not start the plan — please try again.')
      setConfirmOpen(false)
    } finally {
      setSubmitting(false)
    }
  }

  // Same missing-destination guard as generateOverview's own doc comment —
  // applies here too since `idle` (a first-ever generation) can hit the
  // exact same blank-endpoint case.
  function openGenerateConfirm() {
    setRouteError(null)
    if (!hasRoute(settings)) {
      setRouteError('Set a start and finish point above first — pick each from the suggestions so we can place it on the map.')
      return
    }
    setConfirmOpen(true)
  }

  // "Generate overview" (2026-07-31): a direct entry point into explore
  // mode from Trip Setup itself, alongside "Generate full plan" — the cheap,
  // repeatable curation pass (generateExploreHighlights, same callable the
  // Map tab's own "Find great stops" button already uses) needs no
  // confirmation the way the expensive full generation does. Navigates to
  // the Map tab once it lands so the traveler immediately sees the result,
  // rather than triggering it and leaving them wondering where it went.
  async function generateOverview() {
    setOverviewError(null)
    setRouteError(null)
    // Checked client-side, before spending a Claude call: a start/finish
    // point defaults to blank ({name: '', lat: 0, lng: 0}), and (0, 0) is a
    // real-looking coordinate, not an obviously-missing one — asking Claude
    // to plan a corridor toward it produced a silent, confusing "0 stops
    // found" with no explanation (reported with a screenshot after "New
    // trip" carried over other settings but the traveler hadn't set a
    // destination yet).
    if (!hasRoute(settings)) {
      setRouteError('Set a start and finish point above first — pick each from the suggestions so we can place it on the map.')
      return
    }
    setOverviewSubmitting(true)
    try {
      await generateExploreHighlights(tripId)
      navigate('/map')
    } catch (error) {
      console.error('generateExploreHighlights failed', error)
      setOverviewError('Could not find stops right now — please try again.')
    } finally {
      setOverviewSubmitting(false)
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
        <div className="flex flex-wrap items-center gap-3">
          {trip.planMeta.status === 'idle' && (
            <button
              type="button"
              data-testid="generate-overview-button"
              onClick={() => void generateOverview()}
              disabled={exploring || submitting}
              className="btn btn-secondary"
            >
              {exploring ? 'Finding great stops…' : 'Generate overview'}
            </button>
          )}
          {(trip.planMeta.status === 'idle' ||
            trip.planMeta.status === 'stale' ||
            trip.planMeta.status === 'error') && (
            <button
              type="button"
              data-testid="generate-plan-button"
              onClick={openGenerateConfirm}
              disabled={submitting}
              className="btn btn-primary"
            >
              {GENERATE_LABEL[trip.planMeta.status]}
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
        {overviewError && (
          <p
            className="mt-2 text-sm text-red-600 dark:text-red-400"
            data-testid="generate-overview-error"
          >
            {overviewError}
          </p>
        )}
        {routeError && (
          <p
            className="mt-2 text-sm text-red-600 dark:text-red-400"
            data-testid="route-required-error"
          >
            {routeError}
          </p>
        )}
        {saveError && (
          <p
            className="mt-2 text-sm text-red-600 dark:text-red-400"
            data-testid="settings-save-error"
          >
            {saveError}
          </p>
        )}
      </div>

      {confirmOpen && (
        <ConfirmGenerateDialog
          title={
            trip.planMeta.status === 'idle'
              ? 'Generate the full day-by-day plan?'
              : 'Regenerate the full day-by-day plan?'
          }
          description={
            trip.planMeta.status === 'idle'
              ? "This fills in every day's route, activities, and restaurants — the expensive step. If you'd rather find the stops worth building around first without paying for full detail, use \"Generate overview\" instead."
              : 'This replaces every day from scratch — a full regeneration, not an incremental update to just what changed.'
          }
          confirmLabel={GENERATE_LABEL[trip.planMeta.status as 'idle' | 'stale' | 'error']}
          submitting={submitting}
          onConfirm={() => void confirmGeneratePlan()}
          onCancel={() => setConfirmOpen(false)}
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
