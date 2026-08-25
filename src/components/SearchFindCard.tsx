import type { LiveFind } from '../lib/liveSearch'
import { isoCountryFlag } from '../lib/countryFlag'

/**
 * One search result, rendered where results can actually be read.
 *
 * Reported 2026-08-25: *"Results are just shown in a small list, not on map
 * properly."* They were, and it was my doing — when the search moved onto
 * the map the results came with it, into a 72px-wide overlay panel that had
 * room for a name and a button. A find carries a photo and a paragraph
 * explaining why it suits this trip, and neither fits there.
 *
 * So results render in the list below the map, in the same column and the
 * same shape as the stops they might become, and the panel above keeps only
 * the controls. Nothing about a find is different from a candidate except
 * that it is not saved yet — so it should not look like a different kind of
 * thing.
 *
 * Dashed rather than solid, because that IS the one difference worth
 * drawing: nothing here is part of the trip until "Add to trip" is pressed.
 */
export function SearchFindCard({
  find,
  added,
  highlighted,
  innerRef,
  onSelect,
  onAdd,
}: {
  find: LiveFind
  added: boolean
  /** Its pin on the map was tapped — see ExploreMapScreen's selectedFind. */
  highlighted: boolean
  innerRef?: (element: HTMLDivElement | null) => void
  onSelect: () => void
  onAdd: () => void
}) {
  return (
    <div
      ref={innerRef}
      role="button"
      tabIndex={0}
      aria-pressed={highlighted}
      data-testid={`search-find-${find.name}`}
      onClick={onSelect}
      onKeyDown={(event) => {
        // Only keys aimed at the card — same guard as ExploreCandidateCard,
        // and for the same reason.
        if (event.target !== event.currentTarget) return
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          onSelect()
        }
      }}
      className={`card cursor-pointer border-dashed p-3 text-sm transition ${
        highlighted ? 'border-orange-600 ring-2 ring-orange-500' : ''
      }`}
    >
      {find.photoUrl && (
        <img
          src={find.photoUrl}
          alt=""
          decoding="async"
          data-testid={`search-find-photo-${find.name}`}
          className="-mx-3 -mt-3 mb-2 h-28 w-[calc(100%+1.5rem)] max-w-none object-cover"
        />
      )}
      <div className="flex flex-wrap items-center gap-1.5">
        <p className="font-semibold text-neutral-900 dark:text-white">
          {find.name} {find.country && isoCountryFlag(find.country)}
        </p>
        <span className="chip chip-neutral px-2 py-0.5 text-xs">Found</span>
      </div>
      {find.why && (
        <p className="mt-1 text-xs leading-relaxed text-neutral-600 dark:text-neutral-300">
          {find.why}
        </p>
      )}
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        <button
          type="button"
          data-testid={`live-add-${find.name}`}
          className="btn btn-sm btn-primary disabled:opacity-40"
          disabled={added}
          onClick={(event) => {
            event.stopPropagation()
            onAdd()
          }}
        >
          {added ? 'Added' : 'Add to trip'}
        </button>
        {find.googleMapsUrl && (
          <a
            href={find.googleMapsUrl}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(event) => event.stopPropagation()}
            className="link text-xs"
          >
            Photos &amp; details
          </a>
        )}
      </div>
    </div>
  )
}

export default SearchFindCard
