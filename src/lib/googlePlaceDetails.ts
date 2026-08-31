/**
 * The parts of a Google place worth keeping on a stop the traveler pinned
 * themselves.
 *
 * Requested 2026-08-31: *"when adding a stop ourselves through add stop from
 * a google location, add its photo and brief description as well. Do not
 * overwrite our own description!"*
 *
 * A hand-added stop wrote name, coordinates and nothing else, so it sat in
 * the list beside researched candidates that each carry a photo and a
 * paragraph — visibly the poor relation, for no reason other than that
 * nobody had asked Places for the rest of what it already had in hand. The
 * autocomplete has resolved the place either way; these fields come back on
 * the same lookup.
 */
export interface GooglePlaceDetails {
  photoUrl?: string
  /** Google's own editorial blurb, where it has one. Most places have none. */
  summary?: string
  rating?: number
  ratingCount?: number
  googleMapsUrl?: string
}

/**
 * A sentence about the place, from what Google actually knows.
 *
 * The same shape `describePlace` uses on the server for a Places-sourced
 * find, and for the same reason: Google gives no prose for most places, so
 * this states the rating and how many people gave it rather than inventing
 * a description. Returns undefined when there is nothing to say, so an
 * empty `why` is left absent rather than filled with a sentence about
 * nothing.
 *
 * THE TRAVELER'S OWN WORDS ALWAYS WIN. This is only ever consulted for a
 * stop whose description field was left empty — see AddCorridorStopForm.
 */
export function describeGooglePlace(
  details: GooglePlaceDetails | null | undefined,
): string | undefined {
  if (!details) return undefined
  const parts: string[] = []
  if (details.summary) parts.push(details.summary.trim())
  if (details.rating != null && details.ratingCount != null) {
    parts.push(`Rated ${details.rating}/5 from ${details.ratingCount} Google reviews.`)
  }
  return parts.length > 0 ? parts.join(' ') : undefined
}

/**
 * What to write into a stop's `why` — the traveler's own words, or Google's
 * if they gave none.
 *
 * Named, and tested by name, because the emphasis was the whole request:
 * *"Do not overwrite our own description!"* Anything the traveler typed
 * wins outright, whitespace-trimmed but otherwise untouched, and Google's
 * blurb is consulted only for a field left genuinely empty.
 */
export function stopDescription(
  typed: string,
  details: GooglePlaceDetails | null | undefined,
): string | undefined {
  const own = typed.trim()
  if (own) return own
  return describeGooglePlace(details)
}
