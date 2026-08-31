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
 *
 * All of them, not one: *"For days with several activities, the header photo
 * should be the activities next to one another."* A day built around a bike
 * park AND a lake is two things, and picking one of them to stand for the
 * day throws away the fact that made it a full day in the first place.
 */
export interface DayPhotoStop {
  id: string
  name: string
  photoUrl?: string
  linkedDayIds?: string[]
}

export interface DayPhoto {
  url: string
  name: string
}

/**
 * How many photographs a header can carry before each is too narrow to
 * recognise. Four across a phone is already about 90px each.
 */
const MAX_HEADER_PHOTOS = 4

export function dayHeaderPhotos(
  dayId: string,
  overnightName: string,
  stops: DayPhotoStop[],
): DayPhoto[] {
  const linked = stops
    .filter(
      (stop) => stop.photoUrl && (stop.linkedDayIds ?? []).includes(dayId),
    )
    // Firestore returns documents in no order the traveler can see, so
    // without this the same day would shuffle its own header on every load.
    .sort((a, b) => a.name.localeCompare(b.name))
  if (linked.length === 0) return []

  // The stop the day is built around leads, so a glance at the strip still
  // answers "where am I sleeping" first.
  const key = fold(overnightName)
  const built = linked.filter((stop) => fold(stop.name) === key)
  const rest = linked.filter((stop) => fold(stop.name) !== key)
  return [...built, ...rest]
    .slice(0, MAX_HEADER_PHOTOS)
    .map((stop) => ({ url: stop.photoUrl!, name: stop.name }))
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
