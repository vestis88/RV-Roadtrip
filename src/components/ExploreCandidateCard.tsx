import { useState } from 'react'
import { estimateDriveMinutes } from '@rv/shared'
import { stayCostOf } from '@rv/shared'
import type {
  CorridorStop,
  CorridorStopPriority,
  SightTimeNeeded,
} from '@rv/shared'
import type { CorridorStopWithId } from '../hooks/useCorridorStops'
import { isoCountryFlag } from '../lib/countryFlag'
import { placeDetailsUrl } from '../lib/mapLinks'
import { formatDriveTime } from '../lib/formatDuration'
import {
  TIER_LABEL,
  TIER_ORDER,
  candidatePriority,
} from '../lib/exploreCandidateActions'

/**
 * What a stay is offered as. Coarse on purpose: this is an intention, not a
 * booking, and a minute-precise control would invite precision the estimate
 * cannot carry. Hours cover a visit; nights cover a basecamp.
 */
const STAY_HOUR_CHOICES = [1, 2, 4, 6, 8]
const STAY_NIGHT_CHOICES = [1, 2, 3, 4, 7]

/**
 * A Date as `<input type="datetime-local">` wants it — YYYY-MM-DDTHH:mm in
 * LOCAL time.
 *
 * Not `toISOString().slice(0, 16)`, which is the tempting one-liner and is
 * wrong: that is UTC, so a traveler in CEST marking something done at 21:00
 * would be shown 19:00 and "correct" it to a time two hours later than the
 * one they meant. The control is local-time by specification; only the value
 * stored is UTC.
 */
function localInputValue(when: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0')
  return (
    `${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(when.getDate())}` +
    `T${pad(when.getHours())}:${pad(when.getMinutes())}`
  )
}

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
  /** Back to an ordinary candidate — see the Unlock button below. */
  onUnlock: () => void
  onReject: () => void
  /**
   * How long the traveler intends to stay, set on the card itself.
   *
   * Offered only for a stop that is actually kept — an hours-or-nights
   * decision about a place you have not decided to visit is noise, and the
   * board's budget only counts kept stops anyway. Absent means "not on the
   * route yet", and no control is drawn.
   */
  onSetStay?: (stay: CorridorStop['stayDuration']) => void
  /**
   * Move this stop one place earlier or later in the driving order
   * (2026-08-23). Offered only on a kept stop, since only kept stops are in
   * the route at all. Using them marks the order as the traveler's, after
   * which Google stops rearranging it until they reset — see routeOrder.
   */
  onMoveUp?: () => void
  onMoveDown?: () => void
  /**
   * Find somewhere to sleep near this stop (2026-08-23). Offered on a kept
   * stop only, and resolved when pressed — it costs Places, Overpass and
   * sometimes Claude, which is why it is not done for every stop up front.
   */
  /**
   * Marking a stop done, which moves it to the diary and takes it out of the
   * route (2026-08-23). Undo is a sibling rather than a toggle, so the two
   * read as different actions on a card where one of them is destructive to
   * the route.
   */
  onMarkDone?: (when: Date, note: string) => void
  onUndoDone?: () => void
  /**
   * Open the day this stop sits on (2026-08-24). Asked because the day strip
   * above the map was the ONLY way in: "it seems I'm not even able to get to
   * the day view without clicking in the day list above the map?" — which
   * was true, and is a poor answer when the thing you are looking at is the
   * stop rather than the date. Absent when the stop has no day yet.
   */
  onOpenDay?: () => void
  onFindOvernight?: () => void
  /** Set while that search is running, so the button can say so. */
  findingOvernight?: boolean
  /** What it found, once it has. */
  overnightOptions?: { name: string; kind: string; why?: string }[]
  /**
   * Offered only where a route already exists to add the stop TO — the plan
   * map. Absent in explore mode, where there is no itinerary yet and locking
   * in is the whole commitment.
   */
  onAddToRoute?: () => void
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
  'worth-a-detour':
    'bg-amber-200 text-amber-900 dark:bg-amber-700 dark:text-amber-50',
  'nice-if-convenient':
    'bg-neutral-200 text-neutral-700 dark:bg-neutral-700 dark:text-neutral-100',
}

/**
 * One row in explore mode's candidate list (below the map — see
 * ExploreMapScreen). The interest selector sets how much the traveler cares
 * about this stop, which is triage and changes nothing about the route;
 * "Lock in" promotes straight to `locked` — the same status a manually
 * pinned stop gets, and the only thing that does bend the route, since both
 * mean "the traveler wants this in the eventual route."
 *
 * It is called "Lock in" because that is what it does. It read "Keep this",
 * which sounds like a preference alongside the interest selector rather than
 * the one commitment on the card that moves the route.
 *
 * Locking is undoable. It wasn't: a locked stop offered only "Remove", which
 * rejected it outright — so changing your mind about committing to a stop
 * cost you the stop, and the only route back was a fresh curation pass that
 * might not propose it again. Unlock returns it to the candidate list with
 * its interest level intact; "Not interested" stays alongside for when the
 * answer really is no.
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
  onUnlock,
  onReject,
  onSetStay,
  onMoveUp,
  onMoveDown,
  onMarkDone,
  onUndoDone,
  onOpenDay,
  onFindOvernight,
  findingOvernight,
  overnightOptions,
  onAddToRoute,
}: ExploreCandidateCardProps) {
  // The diary form, opened by "We've done this" rather than shown always:
  // marking done is a two-line form, and drawing it on every kept card would
  // bury the actions that are used far more often.
  const [doneFormOpen, setDoneFormOpen] = useState(false)
  const [doneWhen, setDoneWhen] = useState('')
  const [doneNote, setDoneNote] = useState('')

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
      // A done stop is drawn back rather than removed. ExploreMapScreen has
      // claimed since 2026-08-23 that the card "stays in the list, muted" —
      // it stayed, and nothing muted it, so a finished stop was
      // indistinguishable from one still ahead of you.
      className={`card cursor-pointer p-3 text-sm transition ${
        stop.doneAt ? 'opacity-60' : ''
      } ${
        highlighted
          ? 'border-orange-600 ring-2 ring-orange-500'
          : onRoute
            ? 'border-sky-600 ring-2 ring-sky-400'
            : ''
      }`}
    >
      {/* Google's own photo of the verified listing (2026-08-17, requested:
       * "Let's get a picture similar to activities to the overview plan as
       * well"). Full-bleed at the top of the card, the way PlaceCard draws
       * one for every activity and restaurant in the day-by-day plan — this
       * is the screen where the traveler decides whether a place is worth
       * driving hours for, and it was the one place with nothing to look at.
       *
       * No placeholder when there is none. PlaceCard shows a camera glyph
       * because its cards sit in a grid where a missing image would break
       * the row; here it would just be a grey band on every stop Places had
       * no photo for.
       *
       * Loaded eagerly, decided rather than defaulted (2026-08-18: "So just
       * implement full photo loading"). The bytes are a separate Place
       * Photo request the browser makes per image, on the project's own
       * key, so lazy loading was the cautious default while the cost was
       * unknown — but it also means a scrolling traveler watches pictures
       * arrive a beat after the card, which is the moment they are
       * comparing places. Whole list up front, with `decoding="async"` so
       * fetching them never blocks the list itself from painting.
       *
       * The URL carries the key in its query string — see the note on
       * "Photos & details" below. That key needs its HTTP-referrer
       * restriction set, which is equally true of the day-by-day plan and
       * has been since PlaceCard existed. */}
      {stop.photoUrl && (
        <img
          src={stop.photoUrl}
          alt=""
          decoding="async"
          data-testid={`explore-candidate-photo-${stop.id}`}
          className="-mx-3 -mt-3 mb-2 h-28 w-[calc(100%+1.5rem)] max-w-none object-cover"
        />
      )}
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
            <span className="chip chip-accent px-2 py-0.5 text-xs">
              Locked in
            </span>
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
         * in route order and only "Lock in" bends the route — it is what
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

        {/* How long we intend to stay (2026-08-23).
         *
         * Requested with the trip budget it feeds: "I want to be able to
         * state how long we intend to stay at that activity/stop." Hours for
         * a visit, nights for a basecamp — the two cost the trip differently
         * and a single number cannot express both (see stayDuration).
         *
         * Pre-filled from the curation estimate rather than blank, so the
         * budget is honest before anyone touches this and the control shows
         * what is already being assumed. */}
        {(onMarkDone || onUndoDone) && (
          <div
            data-testid={`explore-candidate-done-${stop.id}`}
            className="pt-1"
            onClick={(event) => event.stopPropagation()}
          >
            {onMarkDone && !doneFormOpen && (
              <button
                type="button"
                data-testid={`explore-candidate-mark-done-${stop.id}`}
                className="btn btn-sm btn-outline"
                onClick={() => {
                  // Defaulted at the moment of opening, not at render: a card
                  // sitting on screen all afternoon would otherwise offer a
                  // "now" from whenever the list last re-rendered.
                  setDoneWhen(localInputValue(new Date()))
                  setDoneNote('')
                  setDoneFormOpen(true)
                }}
              >
                We&rsquo;ve done this
              </button>
            )}
            {onMarkDone && doneFormOpen && (
              <div
                data-testid={`explore-candidate-done-form-${stop.id}`}
                className="space-y-1.5"
              >
                <input
                  type="datetime-local"
                  data-testid={`explore-candidate-done-when-${stop.id}`}
                  className="field field-sm"
                  aria-label="When did you do this?"
                  value={doneWhen}
                  onChange={(event) => setDoneWhen(event.target.value)}
                />
                <textarea
                  data-testid={`explore-candidate-done-note-${stop.id}`}
                  className="field field-sm"
                  rows={2}
                  aria-label="Diary note"
                  placeholder="Anything worth remembering? (optional)"
                  value={doneNote}
                  onChange={(event) => setDoneNote(event.target.value)}
                />
                <div className="flex flex-wrap gap-1.5">
                  <button
                    type="button"
                    data-testid={`explore-candidate-done-save-${stop.id}`}
                    className="btn btn-sm btn-primary"
                    onClick={() => {
                      // An emptied field parses to Invalid Date, which would
                      // reach Firestore as "Invalid Date".toISOString() and
                      // throw. Falling back to now keeps one tap from losing
                      // the entry.
                      const parsed = new Date(doneWhen)
                      onMarkDone(
                        Number.isFinite(parsed.getTime()) ? parsed : new Date(),
                        doneNote.trim(),
                      )
                      setDoneFormOpen(false)
                    }}
                  >
                    Add to diary
                  </button>
                  <button
                    type="button"
                    data-testid={`explore-candidate-done-cancel-${stop.id}`}
                    className="btn btn-sm btn-outline"
                    onClick={() => setDoneFormOpen(false)}
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}
            {onUndoDone && (
              <span className="flex items-center gap-2">
                <span
                  data-testid={`explore-candidate-done-at-${stop.id}`}
                  className="text-xs text-neutral-500 dark:text-neutral-400"
                >
                  Done {stop.doneAt?.slice(0, 10)}
                </span>
                <button
                  type="button"
                  data-testid={`explore-candidate-undo-done-${stop.id}`}
                  className="link text-xs"
                  onClick={onUndoDone}
                >
                  Undo
                </button>
              </span>
            )}
          </div>
        )}

        {onFindOvernight && (
          <div
            data-testid={`explore-candidate-sleep-${stop.id}`}
            className="pt-1"
            onClick={(event) => event.stopPropagation()}
          >
            <button
              type="button"
              data-testid={`explore-candidate-find-sleep-${stop.id}`}
              className="btn btn-sm btn-outline"
              disabled={findingOvernight}
              onClick={onFindOvernight}
            >
              {findingOvernight ? 'Looking…' : 'Where to sleep'}
            </button>
            {overnightOptions && overnightOptions.length > 0 && (
              <ul
                data-testid={`explore-candidate-sleep-list-${stop.id}`}
                className="mt-1.5 space-y-0.5 text-xs text-neutral-600 dark:text-neutral-300"
              >
                {overnightOptions.map((option) => (
                  <li key={`${option.kind}:${option.name}`}>
                    <span className="chip chip-neutral mr-1 px-1.5 py-0.5 text-[10px]">
                      {option.kind}
                    </span>
                    {option.name}
                  </li>
                ))}
              </ul>
            )}
            {overnightOptions && overnightOptions.length === 0 && (
              <p
                data-testid={`explore-candidate-sleep-none-${stop.id}`}
                className="mt-1.5 text-xs text-neutral-500 dark:text-neutral-400"
              >
                Nothing found near here — try a nearby stop.
              </p>
            )}
          </div>
        )}

        {(onMoveUp || onMoveDown) && (
          <div
            data-testid={`explore-candidate-move-${stop.id}`}
            className="flex items-center gap-1 pt-1"
            onClick={(event) => event.stopPropagation()}
          >
            <span className="text-xs text-neutral-500 dark:text-neutral-400">
              Order
            </span>
            <button
              type="button"
              data-testid={`explore-candidate-move-up-${stop.id}`}
              className="btn btn-sm btn-outline px-2.5"
              onClick={onMoveUp}
            >
              ↑
            </button>
            <button
              type="button"
              data-testid={`explore-candidate-move-down-${stop.id}`}
              className="btn btn-sm btn-outline px-2.5"
              onClick={onMoveDown}
            >
              ↓
            </button>
          </div>
        )}

        {onSetStay && (
          <div
            data-testid={`explore-candidate-stay-${stop.id}`}
            className="flex flex-wrap items-center gap-1.5 pt-1"
            onClick={(event) => event.stopPropagation()}
          >
            <span className="text-xs text-neutral-500 dark:text-neutral-400">
              Staying
            </span>
            <select
              data-testid={`explore-candidate-stay-hours-${stop.id}`}
              className="select-pill"
              value={
                stop.stayDuration?.kind === 'nights'
                  ? `nights:${stop.stayDuration.nights}`
                  : `hours:${stayCostOf(stop).hours}`
              }
              onChange={(event) => {
                const [kind, amount] = event.target.value.split(':')
                onSetStay(
                  kind === 'nights'
                    ? { kind: 'nights', nights: Number(amount) }
                    : { kind: 'hours', hours: Number(amount) },
                )
              }}
            >
              {STAY_HOUR_CHOICES.map((hours) => (
                <option key={`hours:${hours}`} value={`hours:${hours}`}>
                  {hours} {hours === 1 ? 'hour' : 'hours'}
                </option>
              ))}
              {STAY_NIGHT_CHOICES.map((nights) => (
                <option key={`nights:${nights}`} value={`nights:${nights}`}>
                  {nights} {nights === 1 ? 'night' : 'nights'}
                </option>
              ))}
            </select>
          </div>
        )}

        <div className="flex flex-wrap items-center gap-1.5 pt-1">
          {/* Reviews, opening hours and the REST of the photos. The card
           * now shows one image (above), which was asked for and is worth
           * the per-load cost; this link is still what reaches everything
           * a thumbnail cannot — every photo, the reviews, the hours —
           * without this app mirroring any of it. Which link is best
           * depends on what the stop carries — see placeDetailsUrl; it
           * used to be the coordinate unconditionally, which reached none
           * of the photos or details this link promises. */}
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
          {onOpenDay && (
            <button
              type="button"
              data-testid={`explore-candidate-open-day-${stop.id}`}
              onClick={(event) => {
                event.stopPropagation()
                onOpenDay()
              }}
              className="link text-xs"
            >
              Open its day
            </button>
          )}
          {/* Both of the uncommitted statuses. A find from "Rescan this
           * area" is written `proposed` when a plan already exists and
           * `candidate` when it does not (see rescanCorridorCallable), and
           * gating on `candidate` alone left every stop curated in explore
           * mode with no action but "Not interested" the moment the plan
           * was generated — reported as "the previously researched thing
           * just look boring and can only be removed". */}
          {(stop.status === 'candidate' || stop.status === 'proposed') && (
            <button
              type="button"
              data-testid={`explore-candidate-lock-${stop.id}`}
              onClick={(event) => {
                event.stopPropagation()
                onLock()
              }}
              className="btn btn-sm btn-primary"
            >
              Lock in
            </button>
          )}
          {stop.status === 'locked' && (
            <button
              type="button"
              data-testid={`explore-candidate-unlock-${stop.id}`}
              onClick={(event) => {
                event.stopPropagation()
                onUnlock()
              }}
              className="btn btn-sm btn-secondary"
            >
              Unlock
            </button>
          )}
          {/* The step that turns curation into an actual change to the
           * itinerary. It used to be the sentence 'Use "Edit route" to add
           * this stop to your itinerary.' — an instruction where the one
           * action that matters should have been. */}
          {onAddToRoute && stop.status === 'locked' && (
            <button
              type="button"
              data-testid={`explore-candidate-add-to-route-${stop.id}`}
              onClick={(event) => {
                event.stopPropagation()
                onAddToRoute()
              }}
              className="btn btn-sm btn-primary"
            >
              Add to route
            </button>
          )}
          {/* Offered whether or not the stop is locked. Undoing a commitment
           * and ruling a place out are different intentions, and collapsing
           * them into one button is what made locking a one-way door. */}
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
        </div>
      </div>
    </div>
  )
}
