import { estimateDriveMinutes } from '@rv/shared'
import type { CorridorStopWithId } from '../hooks/useCorridorStops'
import { isoCountryFlag } from '../lib/countryFlag'
import { googleMapsSearchUrl } from '../lib/mapLinks'
import { formatDriveTime } from '../lib/formatDuration'

interface ExploreCandidateCardProps {
  stop: CorridorStopWithId
  detourKm: number | null
  /** This stop is itself part of the route backbone, so it has no detour. */
  onRoute: boolean
  highlighted: boolean
  canVoteUp: boolean
  canVoteDown: boolean
  /** Lets the list scroll this card into view when its map pin is tapped. */
  innerRef?: (element: HTMLDivElement | null) => void
  onSelect: () => void
  onVoteUp: () => void
  onVoteDown: () => void
  onLock: () => void
  onReject: () => void
}

/**
 * One row in explore mode's candidate list (below the map — see
 * ExploreMapScreen). Up/down votes move the stop a whole category at a time
 * (see voteExploreCandidate's own doc comment); "Keep this" promotes
 * straight to `locked` — the same status a manually pinned stop gets, since
 * both mean "the traveler wants this in the eventual route."
 */
export function ExploreCandidateCard({
  stop,
  detourKm,
  onRoute,
  highlighted,
  canVoteUp,
  canVoteDown,
  innerRef,
  onSelect,
  onVoteUp,
  onVoteDown,
  onLock,
  onReject,
}: ExploreCandidateCardProps) {
  return (
    <div
      ref={innerRef}
      // Tap-to-highlight is this card's primary interaction, so it needs the
      // same keyboard affordance PlaceCard already implements — without it
      // only the vote/keep/reject buttons were reachable, and the card
      // itself could not be activated at all without a pointer.
      role="button"
      tabIndex={0}
      aria-pressed={highlighted}
      data-testid={`explore-candidate-${stop.id}`}
      onClick={onSelect}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          onSelect()
        }
      }}
      // The same two states PlaceCard and MarkerBadge already draw, in the
      // same colours: orange for "I just tapped this to look at it", sky for
      // "this one is in my route". `onRoute` is the kept (`locked`) set,
      // the same one the route line is drawn through, so the card, the pin
      // and the drawn route always agree about which stops are in.
      className={`card flex cursor-pointer gap-3 p-3 text-sm transition ${
        highlighted
          ? 'border-orange-600 ring-2 ring-orange-500'
          : onRoute
            ? 'border-sky-600 ring-2 ring-sky-400'
            : ''
      }`}
    >
      <div className="flex flex-col items-center gap-0.5">
        <button
          type="button"
          data-testid={`explore-candidate-up-${stop.id}`}
          disabled={!canVoteUp}
          onClick={(event) => {
            event.stopPropagation()
            onVoteUp()
          }}
          className="rounded px-1.5 text-neutral-400 hover:text-neutral-700 disabled:opacity-30 dark:hover:text-neutral-200"
          aria-label="Vote up"
        >
          ▲
        </button>
        <button
          type="button"
          data-testid={`explore-candidate-down-${stop.id}`}
          disabled={!canVoteDown}
          onClick={(event) => {
            event.stopPropagation()
            onVoteDown()
          }}
          className="rounded px-1.5 text-neutral-400 hover:text-neutral-700 disabled:opacity-30 dark:hover:text-neutral-200"
          aria-label="Vote down"
        >
          ▼
        </button>
      </div>

      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex flex-wrap items-center gap-1.5">
          <p className="font-semibold text-neutral-900 dark:text-white">
            {stop.name} {stop.country && isoCountryFlag(stop.country)}
          </p>
          {onRoute ? (
            // A stop the route is already built through has no detour to
            // report — "≈+0 km" reads like a suspiciously good deal rather
            // than "this one IS the route".
            <span
              data-testid={`explore-candidate-onroute-${stop.id}`}
              className="chip chip-accent px-2 py-0.5 text-xs"
            >
              On route
            </span>
          ) : (
            detourKm !== null && (
              // Distance and time in one chip, both derived from the same
              // straight-line estimate so they stay consistent with each
              // other (see estimateDriveMinutes on why no road factor is
              // applied). Two chips read as two independent measurements;
              // this is one measurement expressed two ways.
              <span
                data-testid={`explore-candidate-detour-${stop.id}`}
                className="chip chip-neutral px-2 py-0.5 text-xs"
                title="Rough estimate from straight-line distance — real roads are longer"
              >
                ≈+{Math.round(detourKm)} km · +
                {formatDriveTime(estimateDriveMinutes(detourKm))}
              </span>
            )
          )}
          {stop.status === 'locked' && (
            <span className="chip chip-accent px-2 py-0.5 text-xs">Keeping</span>
          )}
        </div>
        {stop.why && (
          <p className="text-xs leading-relaxed text-neutral-600 dark:text-neutral-300">
            {stop.why}
          </p>
        )}
        <div className="flex flex-wrap items-center gap-1.5 pt-1">
          {/* Photos, reviews and opening hours, without this app paying to
            * mirror any of them: Places photo media is billed per load and
            * puts the API key in a scrapeable <img src>, whereas a link
            * costs nothing and lands the traveler somewhere strictly richer
            * than a thumbnail. Coordinates rather than a place ID, so it
            * works for every stop already in Firestore — see
            * googleMapsSearchUrl's own note on the precision tradeoff. */}
          <a
            href={googleMapsSearchUrl(stop.lat, stop.lng)}
            target="_blank"
            rel="noopener noreferrer"
            data-testid={`explore-candidate-maps-${stop.id}`}
            onClick={(event) => event.stopPropagation()}
            className="text-xs font-medium text-orange-600 underline underline-offset-2 hover:text-orange-500 dark:text-orange-400"
          >
            Photos &amp; details
          </a>
          {stop.status === 'candidate' && (
            <button
              type="button"
              data-testid={`explore-candidate-lock-${stop.id}`}
              onClick={(event) => {
                event.stopPropagation()
                onLock()
              }}
              className="btn btn-sm btn-primary"
            >
              Keep this
            </button>
          )}
          {stop.status === 'locked' && (
            <button
              type="button"
              data-testid={`explore-candidate-unlock-${stop.id}`}
              onClick={(event) => {
                event.stopPropagation()
                onReject()
              }}
              className="btn btn-sm btn-secondary"
            >
              Remove
            </button>
          )}
          {stop.status === 'candidate' && (
            <button
              type="button"
              data-testid={`explore-candidate-reject-${stop.id}`}
              onClick={(event) => {
                event.stopPropagation()
                onReject()
              }}
              className="btn btn-sm btn-secondary text-neutral-500 dark:text-neutral-400"
            >
              Not interested
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
