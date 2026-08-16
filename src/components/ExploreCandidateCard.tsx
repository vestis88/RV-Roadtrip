import { estimateDriveMinutes } from '@rv/shared'
import type { CorridorStopPriority, SightTimeNeeded } from '@rv/shared'
import type { CorridorStopWithId } from '../hooks/useCorridorStops'
import { isoCountryFlag } from '../lib/countryFlag'
import { placeDetailsUrl } from '../lib/mapLinks'
import { formatDriveTime } from '../lib/formatDuration'
import {
  TIER_LABEL,
  TIER_ORDER,
  candidatePriority,
} from '../lib/exploreCandidateActions'

interface ExploreCandidateCardProps {
  stop: CorridorStopWithId
  detourKm: number | null
  /** This stop is itself part of the route backbone, so it has no detour. */
  onRoute: boolean
  highlighted: boolean
  /** Lets the list scroll this card into view when its map pin is tapped. */
  innerRef?: (element: HTMLDivElement | null) => void
  onSelect: () => void
  onSetPriority: (priority: CorridorStopPriority) => void
  onLock: () => void
  onReject: () => void
}

/**
 * How each interest level is drawn, most interested first. Same three
 * colours the level always had; only where they appear changed, from a
 * section heading the card sat under to the card itself.
 */
/**
 * How long a sight takes, in words a traveler reads rather than the enum
 * the routing reasons with. It is on the card because it is the single
 * fact that decides whether a stop fits the day it lands on — see
 * PACING_RULES in functions/src/prompts/planTripPrompt.ts, which paces the
 * day's driving against exactly this.
 */
const TIME_NEEDED_LABEL: Record<SightTimeNeeded, string> = {
  'couple-of-hours': 'A couple of hours',
  'half-day': 'Half a day',
  'full-day': 'A full day',
}

const TIER_STYLE: Record<CorridorStopPriority, string> = {
  'must-see': 'bg-orange-600 text-white',
  'worth-a-detour': 'bg-amber-200 text-amber-900 dark:bg-amber-700 dark:text-amber-50',
  'nice-if-convenient':
    'bg-neutral-200 text-neutral-700 dark:bg-neutral-700 dark:text-neutral-100',
}

/**
 * One row in explore mode's candidate list (below the map — see
 * ExploreMapScreen). The interest selector sets how much the traveler cares
 * about this stop, which is triage and changes nothing about the route;
 * "Keep this" promotes straight to `locked` — the same status a manually
 * pinned stop gets, and the only thing that does bend the route, since both
 * mean "the traveler wants this in the eventual route."
 */
export function ExploreCandidateCard({
  stop,
  detourKm,
  onRoute,
  highlighted,
  innerRef,
  onSelect,
  onSetPriority,
  onLock,
  onReject,
}: ExploreCandidateCardProps) {
  const priority = candidatePriority(stop)
  // A sight whose base town is its own name is a place that IS the stop (a
  // town curated before sights led the route, or a pin dropped by hand) —
  // "Sleep in Otta" under a card headed "Otta" says nothing.
  const showBaseTown = !!stop.baseTown && stop.baseTown !== stop.name
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
      className={`card cursor-pointer p-3 text-sm transition ${
        highlighted
          ? 'border-orange-600 ring-2 ring-orange-500'
          : onRoute
            ? 'border-sky-600 ring-2 ring-sky-400'
            : ''
      }`}
    >
      <div className="min-w-0 space-y-1">
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
        {/* What this stop actually is, now that a candidate is a sight
          * rather than a town: where you'd sleep to see it, which of your
          * own interests it answers, and how much of a day it takes. The
          * interest in particular is the whole promise of the curation
          * phase — showing it turns "trust us, this suits you" into
          * something the traveler can check at a glance. All three are
          * absent on a stop curated before sights led the route, and on a
          * pin the traveler dropped themselves, so each stands alone. */}
        {(showBaseTown || stop.interest || stop.timeNeeded) && (
          <div
            data-testid={`explore-candidate-facts-${stop.id}`}
            className="flex flex-wrap items-center gap-1.5"
          >
            {showBaseTown && (
              <span className="text-xs text-neutral-500 dark:text-neutral-400">
                Sleep in {stop.baseTown}
              </span>
            )}
            {stop.interest && (
              <span
                data-testid={`explore-candidate-serves-${stop.id}`}
                className="chip chip-neutral px-2 py-0.5 text-xs"
                title="The interest you named in Trip Setup that this stop is here for"
              >
                For: {stop.interest}
              </span>
            )}
            {stop.timeNeeded && (
              <span
                data-testid={`explore-candidate-time-${stop.id}`}
                className="chip chip-neutral px-2 py-0.5 text-xs"
              >
                {TIME_NEEDED_LABEL[stop.timeNeeded]}
              </span>
            )}
          </div>
        )}
        {stop.why && (
          <p className="text-xs leading-relaxed text-neutral-600 dark:text-neutral-300">
            {stop.why}
          </p>
        )}
        {/* How much the traveler cares, set directly rather than nudged a
          * step at a time. It sorts nothing and moves nothing — the list is
          * in route order and only "Keep this" bends the route — it is what
          * the eventual full generation is told to weigh when deciding what
          * fits. Claude's own pick is what's selected until it's changed. */}
        <div
          role="radiogroup"
          aria-label="How interested are you in this stop?"
          data-testid={`explore-candidate-interest-${stop.id}`}
          className="flex flex-wrap gap-1 pt-1"
        >
          {TIER_ORDER.map((tier) => {
            const active = tier === priority
            return (
              <button
                key={tier}
                type="button"
                role="radio"
                aria-checked={active}
                data-testid={`explore-candidate-interest-${tier}-${stop.id}`}
                // Same as every other control on the card: setting the level
                // must not also count as tapping the card to look at it.
                onClick={(event) => {
                  event.stopPropagation()
                  onSetPriority(tier)
                }}
                className={`rounded-full px-2.5 py-1 text-xs font-medium transition ${
                  active
                    ? TIER_STYLE[tier]
                    : 'bg-neutral-100 text-neutral-500 hover:bg-neutral-200 dark:bg-neutral-800 dark:text-neutral-400 dark:hover:bg-neutral-700'
                }`}
              >
                {TIER_LABEL[tier]}
              </button>
            )
          })}
        </div>

        <div className="flex flex-wrap items-center gap-1.5 pt-1">
          {/* Photos, reviews and opening hours, without this app paying to
            * mirror any of them: Places photo media is billed per load and
            * puts the API key in a scrapeable <img src>, whereas a link
            * costs nothing and lands the traveler somewhere strictly richer
            * than a thumbnail. Which link is best depends on what the
            * stop carries — see placeDetailsUrl; it used to be the
            * coordinate unconditionally, which reached none of the photos
            * or details this link promises. */}
          <a
            href={placeDetailsUrl(stop)}
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
