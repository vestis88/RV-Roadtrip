import { useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import type { CountryBriefSection } from '@rv/shared'
import { useTripContext } from '../context/TripContext'
import { useCountryBrief } from '../hooks/useCountryBrief'
import {
  useCountryGuideSections,
  type ResolvedSection,
} from '../hooks/useCountryGuideSections'
import {
  researchCountrySections,
  saveCountryBrief,
  sectionIdFromTitle,
} from '../lib/countryBriefActions'
import { EUROPEAN_COUNTRIES } from '../lib/countries'
import { isoCountryFlag } from '../lib/countryFlag'

function countryName(code: string): string {
  return EUROPEAN_COUNTRIES.find((c) => c.code === code)?.name ?? code
}

function SectionCard({
  resolved,
  busy,
  onResearch,
  onEdit,
  onRemove,
}: {
  resolved: ResolvedSection
  busy: boolean
  onResearch: () => void
  onEdit: () => void
  onRemove: () => void
}) {
  const { section, guide } = resolved
  return (
    <div className="card p-3" data-testid={`country-section-${section.id}`}>
      <div className="flex items-start justify-between gap-2">
        <h3 className="font-medium text-neutral-900 dark:text-white">
          {section.title}
        </h3>
        <div className="flex shrink-0 gap-1">
          <button
            type="button"
            data-testid={`section-research-${section.id}`}
            onClick={onResearch}
            disabled={busy}
            className="btn btn-sm btn-secondary"
          >
            {busy ? 'Researching…' : guide ? 'Re-research' : 'Research'}
          </button>
          <button
            type="button"
            data-testid={`section-edit-${section.id}`}
            onClick={onEdit}
            className="btn btn-sm btn-ghost"
            aria-label={`Edit what to research for ${section.title}`}
          >
            Edit
          </button>
        </div>
      </div>

      {guide ? (
        <>
          <ul className="mt-2 list-disc space-y-1 pl-4 text-sm text-neutral-700 dark:text-neutral-300">
            {guide.items.map((item, i) => (
              <li key={i}>{item}</li>
            ))}
          </ul>
          {guide.sources.length > 0 && (
            <details className="mt-2 text-xs text-neutral-500 dark:text-neutral-400">
              <summary className="cursor-pointer">Sources</summary>
              <ul className="mt-1 space-y-1">
                {guide.sources.map((url) => (
                  <li key={url}>
                    <a href={url} target="_blank" rel="noreferrer" className="link">
                      {url}
                    </a>
                  </li>
                ))}
              </ul>
            </details>
          )}
          <p className="mt-2 text-xs text-neutral-500 dark:text-neutral-400">
            Researched {guide.generatedAt.slice(0, 10)}
          </p>
        </>
      ) : (
        <p
          className="mt-2 text-sm text-neutral-500 dark:text-neutral-400"
          data-testid={`section-empty-${section.id}`}
        >
          Not researched for this country yet.
        </p>
      )}

      <details className="mt-2 text-xs text-neutral-500 dark:text-neutral-400">
        <summary className="cursor-pointer">What gets asked</summary>
        <p className="mt-1" data-testid={`section-brief-${section.id}`}>
          {section.brief}
        </p>
        <button
          type="button"
          data-testid={`section-remove-${section.id}`}
          onClick={onRemove}
          className="link mt-2 text-red-600 dark:text-red-400"
        >
          Remove from my research list
        </button>
      </details>
    </div>
  )
}

export function CountryDetailScreen() {
  const { tripId, trip, uid } = useTripContext()
  const { code = '' } = useParams<{ code: string }>()
  const vehicle = trip.settings.vehicle
  const { sections } = useCountryBrief(uid)
  const { resolved, loading } = useCountryGuideSections(code, sections, vehicle)
  const [busyIds, setBusyIds] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)
  const [editing, setEditing] = useState<CountryBriefSection | null>(null)
  const [draftTitle, setDraftTitle] = useState('')
  const [draftBrief, setDraftBrief] = useState('')
  const [draftVehicle, setDraftVehicle] = useState(false)

  const unresearched = resolved
    .filter((entry) => !entry.guide)
    .map((entry) => entry.section.id)

  async function research(sectionIds: string[]) {
    if (sectionIds.length === 0) return
    setBusyIds((prev) => [...prev, ...sectionIds])
    setError(null)
    try {
      const result = await researchCountrySections(
        tripId,
        code,
        countryName(code),
        sectionIds,
      )
      if (result.failed.length > 0) {
        setError(
          `Could not research ${result.failed.length} of ${sectionIds.length} — the rest are saved.`,
        )
      }
    } catch (err) {
      console.error('researchCountrySections failed', err)
      setError('Could not research that right now — please try again.')
    } finally {
      setBusyIds((prev) => prev.filter((id) => !sectionIds.includes(id)))
    }
  }

  function openEditor(section: CountryBriefSection | null) {
    setEditing(section ?? { id: '', title: '', brief: '', dependsOnVehicle: false })
    setDraftTitle(section?.title ?? '')
    setDraftBrief(section?.brief ?? '')
    setDraftVehicle(section?.dependsOnVehicle ?? false)
  }

  async function saveEditor() {
    if (!editing || !uid) return
    const title = draftTitle.trim()
    const brief = draftBrief.trim()
    if (!title || !brief) return
    const isNew = editing.id === ''
    const next: CountryBriefSection = {
      id: isNew ? sectionIdFromTitle(title) : editing.id,
      title,
      brief,
      dependsOnVehicle: draftVehicle,
    }
    const updated = isNew
      ? [...sections, next]
      : sections.map((section) => (section.id === editing.id ? next : section))
    setEditing(null)
    try {
      await saveCountryBrief(uid, updated)
    } catch (err) {
      console.error('saveCountryBrief failed', err)
      setError('Could not save your research list — please try again.')
    }
  }

  async function removeSection(sectionId: string) {
    if (!uid) return
    try {
      await saveCountryBrief(
        uid,
        sections.filter((section) => section.id !== sectionId),
      )
    } catch (err) {
      console.error('saveCountryBrief failed', err)
      setError('Could not save your research list — please try again.')
    }
  }

  return (
    <div className="mx-auto max-w-2xl p-4 text-left">
      <Link to="/countries" className="link text-sm">
        ← Back to countries
      </Link>

      <div className="mt-4 flex items-center justify-between gap-2">
        <h2 className="heading-md">
          {isoCountryFlag(code)} {countryName(code)}
        </h2>
        <button
          type="button"
          data-testid="research-missing-sections"
          onClick={() => void research(unresearched)}
          disabled={unresearched.length === 0 || busyIds.length > 0}
          className="btn btn-sm btn-secondary"
        >
          {unresearched.length === 0
            ? 'All researched'
            : `Research ${unresearched.length} missing`}
        </button>
      </div>

      <p className="mt-1 text-xs text-neutral-500 dark:text-neutral-400">
        Your research list applies to every country, and answers are kept
        across trips.
      </p>

      {error && (
        <p
          className="mt-2 text-sm text-red-600 dark:text-red-400"
          data-testid="research-error"
        >
          {error}
        </p>
      )}

      {loading ? (
        <p className="mt-4 text-neutral-500 dark:text-neutral-400">Loading…</p>
      ) : (
        <div className="mt-4 space-y-3" data-testid="country-guide">
          {resolved.map((entry) => (
            <SectionCard
              key={entry.section.id}
              resolved={entry}
              busy={busyIds.includes(entry.section.id)}
              onResearch={() => void research([entry.section.id])}
              onEdit={() => openEditor(entry.section)}
              onRemove={() => void removeSection(entry.section.id)}
            />
          ))}
        </div>
      )}

      <button
        type="button"
        data-testid="add-research-section"
        onClick={() => openEditor(null)}
        className="btn btn-secondary mt-4"
      >
        Add something to research
      </button>

      {editing && (
        <div className="card mt-3 space-y-2 p-3" data-testid="section-editor">
          <label className="block">
            <span className="field-label">Title</span>
            <input
              className="field"
              data-testid="section-editor-title"
              value={draftTitle}
              onChange={(event) => setDraftTitle(event.target.value)}
              placeholder="Drinking water"
            />
          </label>
          <label className="block">
            <span className="field-label">What should be looked up?</span>
            <textarea
              className="field"
              rows={4}
              data-testid="section-editor-brief"
              value={draftBrief}
              onChange={(event) => setDraftBrief(event.target.value)}
              placeholder="Where to refill fresh drinking water — public taps, service points, whether they cost anything."
            />
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              data-testid="section-editor-vehicle"
              checked={draftVehicle}
              onChange={(event) => setDraftVehicle(event.target.checked)}
            />
            <span>
              The answer depends on my RV (re-researched if I change vehicle)
            </span>
          </label>
          <div className="flex gap-2">
            <button
              type="button"
              data-testid="section-editor-save"
              onClick={() => void saveEditor()}
              disabled={!draftTitle.trim() || !draftBrief.trim()}
              className="btn btn-primary"
            >
              Save
            </button>
            <button
              type="button"
              data-testid="section-editor-cancel"
              onClick={() => setEditing(null)}
              className="btn btn-ghost"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

export default CountryDetailScreen
