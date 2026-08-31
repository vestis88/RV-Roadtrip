/**
 * The picture a day shows at the top of Day View.
 *
 * Requested 2026-08-31: *"Also carry the overview pic from planning in as a
 * header picture for day view."*
 *
 * The photo already exists — it is the one on the stop's card in the
 * planning list, fetched when the stop was curated, found by a rescan, or
 * pinned by hand. Day View simply never asked for it, so a day built around
 * a place the traveler had been looking at a photograph of all week opened
 * as a wall of text.
 *
 * The link is `linkedDayIds`: the stops that claim this day are the stops
 * the day is FOR. Where several claim it, the one the day is built around
 * wins — matched against the day's own overnight name — and otherwise the
 * first by name, so the same day always shows the same picture rather than
 * whichever stop Firestore happened to return first.
 *
 * Deliberately NOT falling back to an activity's photo. Those are places
 * inside the day rather than the reason for it, and a day headed by a
 * photograph of its lunch restaurant is a worse answer than a day with no
 * header photograph at all — the same call DiaryScreen's rows make.
 */
export interface DayPhotoStop {
  id: string
  name: string
  photoUrl?: string
  linkedDayIds?: string[]
}

export function dayHeaderPhoto(
  dayId: string,
  overnightName: string,
  stops: DayPhotoStop[],
): { url: string; name: string } | undefined {
  const linked = stops
    .filter(
      (stop) => stop.photoUrl && (stop.linkedDayIds ?? []).includes(dayId),
    )
    .sort((a, b) => a.name.localeCompare(b.name))
  if (linked.length === 0) return undefined

  const key = fold(overnightName)
  const built = linked.find((stop) => fold(stop.name) === key)
  const chosen = built ?? linked[0]
  return { url: chosen.photoUrl!, name: chosen.name }
}

/** Folded the way stop names are compared elsewhere — see normalizeStopName. */
function fold(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}
