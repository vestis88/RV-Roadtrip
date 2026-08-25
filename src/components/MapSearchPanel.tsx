import { useState } from 'react'
import type { LatLng, PlanMeta } from '@rv/shared'
import { RescanCorridorButton } from './RescanCorridorButton'
import { LIVE_PRESETS, searchAroundUs, type LiveFind } from '../lib/liveSearch'
import { describeExploreHighlightsError } from '../lib/exploreCandidateActions'

/**
 * Both searches, on the map, sharing an anchor and a radius.
 *
 * Requested 2026-08-24: *"The find nearby doesn't need to be triggered from a
 * separate tab. Use the map view, so it's easy to see the location of the
 * results. Also, currently the results are a bit too far away, so it needs to
 * be given the option to specify radius… it's very common to rescan area, so
 * maybe they should be integrated?"*
 *
 * WHAT MERGED AND WHAT DID NOT, which is the whole design.
 *
 * The **surface** merged: one panel, one anchor control, one radius, and
 * results you can see on the map rather than in a list on another tab.
 *
 * The **actions** did not, and deliberately. The one thing that separates
 * these two searches is whether they WRITE to the trip. Rescan writing is
 * the point — it is how a scan becomes stops you can curate, and the reject
 * tombstone that stops the next scan handing back what you turned down only
 * works because results are written. "Near us" not writing is equally the
 * point: looking for lunch three times a day would fill the corridor with
 * pins nobody chose. Collapsing them into one button with a "save these?"
 * flag would make a boolean decide whether an action mutates the trip, which
 * is the same shape as the mistake `searchNearby` was split out to avoid.
 *
 * So: two buttons, unchanged semantics, everything around them shared.
 */

/**
 * Radii offered, in km.
 *
 * The short end is the reported bug: "Near us" was pinned at 25 km, which is
 * a reasonable planning distance and a ridiculous one for finding lunch. The
 * long end is what a regional rescan needs. The list is offered whole for
 * both searches rather than split, because a traveler who wants a 2 km scan
 * of the valley they are parked in is not making a mistake.
 */
const RADIUS_CHOICES_KM = [2, 5, 10, 25, 50, 100, 150]

export type SearchAnchor = 'map' | 'position'

export function MapSearchPanel({
  tripId,
  mapCenter,
  position,
  planMeta,
  area,
  anchor,
  onAnchorChange,
  radiusOverrideKm,
  onRadiusOverrideChange,
  armed,
  onArmedChange,
  onFinds,
  finds,
}: {
  tripId: string
  mapCenter: LatLng
  position: { lat: number; lng: number } | null
  planMeta: PlanMeta
  /** The circle actually drawn and searched — see ExploreMapScreen. */
  area: { radiusKm: number; cappedFrom?: number }
  anchor: SearchAnchor
  onAnchorChange: (anchor: SearchAnchor) => void
  /** null = follow the viewport, which is what the map already did. */
  radiusOverrideKm: number | null
  onRadiusOverrideChange: (km: number | null) => void
  armed: boolean
  onArmedChange: (armed: boolean) => void
  /** Ephemeral finds, lifted so the map can draw them. */
  onFinds: (finds: LiveFind[] | null) => void
  finds: LiveFind[] | null
}) {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [freeText, setFreeText] = useState('')

  // Where the search happens. The anchor is a real choice rather than being
  // implied by which button was pressed: "what's near us" while panning
  // tomorrow's route, and "scan this valley" while parked in it, are both
  // things people want.
  const searchCentre =
    anchor === 'position' && position
      ? { lat: position.lat, lng: position.lng }
      : mapCenter

  async function runNearby(id: string, query: string) {
    setBusy(id)
    setError(null)
    onFinds(null)
    try {
      onFinds(
        await searchAroundUs(tripId, searchCentre, query, area.radiusKm),
      )
    } catch (err) {
      console.error('Nearby search failed', err)
      setError(describeExploreHighlightsError(err))
    } finally {
      setBusy(null)
    }
  }

  /**
   * A scan outlives the panel, so its status has to as well.
   *
   * The panel's open state is local and dies on every hop to Diary and back
   * — and a rescan can run for minutes. Collapsing the panel over a running
   * scan would hide the elapsed counter, the stale-scan recovery and the
   * durable error, all of which exist because these failures used to arrive
   * with nothing attached. So a scan in flight keeps its own button on the
   * map whether the panel is open or not.
   */
  const scanning = planMeta.rescanStatus === 'generating'

  if (!open) {
    return (
      <div className="flex flex-col items-end gap-1">
        <button
          type="button"
          data-testid="open-map-search"
          onClick={() => setOpen(true)}
          className="btn btn-sm border border-neutral-300 bg-white/95 text-neutral-700 shadow-md backdrop-blur-sm hover:bg-neutral-100 dark:border-neutral-600 dark:bg-neutral-900/95 dark:text-neutral-100 dark:hover:bg-neutral-800"
        >
          Search
        </button>
        {scanning ? (
          <RescanCorridorButton
            tripId={tripId}
            center={searchCentre}
            area={area}
            planMeta={planMeta}
            armed={armed}
            onArmedChange={onArmedChange}
          />
        ) : (
          // What the last scan had to say, without its controls. A result
          // and a failure both outlive the panel that started them.
          <RescanCorridorButton
            statusOnly
            tripId={tripId}
            center={searchCentre}
            area={area}
            planMeta={planMeta}
            armed={armed}
            onArmedChange={onArmedChange}
          />
        )}
      </div>
    )
  }

  return (
    <div
      data-testid="map-search-panel"
      className="w-72 rounded-xl border border-neutral-300 bg-white/95 p-2 text-xs shadow-md backdrop-blur-sm dark:border-neutral-600 dark:bg-neutral-900/95"
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex gap-1" role="radiogroup" aria-label="Search around">
          <button
            type="button"
            role="radio"
            aria-checked={anchor === 'map'}
            data-testid="search-anchor-map"
            className={`chip px-2 py-1 ${anchor === 'map' ? 'chip-accent' : 'chip-neutral'}`}
            onClick={() => onAnchorChange('map')}
          >
            Map centre
          </button>
          <button
            type="button"
            role="radio"
            aria-checked={anchor === 'position'}
            data-testid="search-anchor-position"
            className={`chip px-2 py-1 disabled:opacity-40 ${anchor === 'position' ? 'chip-accent' : 'chip-neutral'}`}
            // Without a fix there is no "here" to search around, and a
            // silently-wrong anchor is worse than a disabled button.
            disabled={!position}
            title={position ? undefined : 'Waiting for your location'}
            onClick={() => onAnchorChange('position')}
          >
            Where we are
          </button>
        </div>
        <button
          type="button"
          data-testid="close-map-search"
          className="link"
          onClick={() => setOpen(false)}
        >
          Close
        </button>
      </div>

      <label className="mt-2 flex items-center gap-2">
        <span className="text-neutral-600 dark:text-neutral-300">Within</span>
        <select
          data-testid="search-radius"
          className="select-pill flex-1"
          value={radiusOverrideKm ?? 'viewport'}
          onChange={(event) =>
            onRadiusOverrideChange(
              event.target.value === 'viewport'
                ? null
                : Number(event.target.value),
            )
          }
        >
          {/* The default stays the viewport, which the traveler confirmed was
            * right ("it was right to limit at 7 km"). This adds an explicit
            * override beside it rather than replacing pinch-to-size. */}
          <option value="viewport">what I can see ({area.radiusKm} km)</option>
          {RADIUS_CHOICES_KM.map((km) => (
            <option key={km} value={km}>
              {km} km
            </option>
          ))}
        </select>
      </label>

      <div className="mt-2 flex flex-wrap gap-1">
        {LIVE_PRESETS.map((preset) => (
          <button
            key={preset.id}
            type="button"
            data-testid={`live-preset-${preset.id}`}
            className="btn btn-sm btn-outline disabled:opacity-40"
            disabled={busy !== null}
            onClick={() => void runNearby(preset.id, preset.query)}
          >
            {busy === preset.id ? 'Looking…' : preset.label}
          </button>
        ))}
      </div>

      <form
        className="mt-2 flex gap-1"
        onSubmit={(event) => {
          event.preventDefault()
          if (freeText.trim()) void runNearby('free', freeText.trim())
        }}
      >
        <input
          data-testid="live-free-text"
          className="field field-sm flex-1"
          placeholder="or describe it"
          value={freeText}
          onChange={(event) => setFreeText(event.target.value)}
        />
        <button
          type="submit"
          data-testid="live-search-button"
          className="btn btn-sm btn-secondary disabled:opacity-40"
          disabled={busy !== null || !freeText.trim()}
        >
          Find
        </button>
      </form>

      {error && (
        <p data-testid="live-error" className="mt-1 text-red-600 dark:text-red-400">
          {error}
        </p>
      )}

      {/* The results themselves render in the LIST below the map, not here.
        *
        * Reported 2026-08-25: "Results are just shown in a small list, not on
        * map properly." A find carries a photo and a paragraph about why it
        * suits this trip, and this overlay is a few hundred pixels wide —
        * so it kept the controls and gave the results back to the column
        * that was built for exactly this shape of card. */}
      {finds && (
        <p className="mt-2 text-neutral-500 dark:text-neutral-400" data-testid="live-finds">
          {finds.length === 0 ? (
            <span data-testid="live-empty">
              Nothing found in that circle. Try wider, or a different wording.
            </span>
          ) : (
            <span data-testid="live-ephemeral-note">
              {finds.length} on the map and in the list below — saved only if
              you add them.
            </span>
          )}
        </p>
      )}

      <div className="mt-2 border-t border-neutral-200 pt-2 dark:border-neutral-700">
        <RescanCorridorButton
          tripId={tripId}
          center={searchCentre}
          area={area}
          planMeta={planMeta}
          armed={armed}
          onArmedChange={onArmedChange}
        />
      </div>
    </div>
  )
}

export default MapSearchPanel
