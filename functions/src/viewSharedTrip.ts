import { getFirestore } from 'firebase-admin/firestore'
import { onRequest } from 'firebase-functions/https'
import type {
  Activity,
  CorridorStop,
  LogEntry,
  Restaurant,
  SharedTripDay,
  SharedTripDiaryEntry,
  SharedTripPlace,
  SharedTripStop,
  SharedTripView,
  Trip,
  TripDay,
} from '@rv/shared'
import { resolveShareToken } from './shareTokens.js'

/**
 * The family share view reads live, on every request, instead of being
 * served from a denormalised copy of the trip: relatives following along
 * from home should see the plan and diary as they are right now, and a
 * mirrored collection would mean a second source of truth to keep in sync
 * (and one more place a trip's contents could be read from). The cost is one
 * fan-out read per request, which is bounded by the trip's own size and
 * happens only while someone actually has the page open.
 */

/**
 * A place a guest never needs to see: `reserve` items are the hidden refill
 * pool (see activitySchema's own comment) and `skipped` ones were explicitly
 * dismissed by the travelers — showing either would present the family with
 * options that are not part of the trip.
 */
function isVisibleToGuests(place: Activity | Restaurant): boolean {
  return !place.reserve && place.status !== 'skipped'
}

function toSharedPlace(
  id: string,
  place: Activity | Restaurant,
): SharedTripPlace {
  return {
    id,
    name: place.name,
    blurb: place.blurb,
    status: place.status,
    ...('category' in place ? { category: place.category } : {}),
    ...('timeOfDay' in place && place.timeOfDay
      ? { timeOfDay: place.timeOfDay }
      : {}),
    ...('meal' in place ? { meal: place.meal } : {}),
    ...(place.rating != null ? { rating: place.rating } : {}),
    ...(place.ratingCount != null ? { ratingCount: place.ratingCount } : {}),
    ...(place.photoUrl ? { photoUrl: place.photoUrl } : {}),
    ...(place.googleMapsUrl ? { googleMapsUrl: place.googleMapsUrl } : {}),
  }
}

/**
 * Diary entries address their place by `refPath`, which a guest cannot read
 * for themselves. Resolved here in one batched `getAll`, and only for paths
 * inside this very trip — an entry pointing anywhere else (a stale path left
 * by an import, or a hand-written one) must not become a way to read a
 * document out of some *other* trip through a share link.
 */
async function resolvePlaceNames(
  tripId: string,
  refPaths: string[],
): Promise<Map<string, string>> {
  const db = getFirestore()
  const prefix = `trips/${tripId}/`
  const valid = [...new Set(refPaths)].filter(
    (path) => path.startsWith(prefix) && path.split('/').length % 2 === 0,
  )
  if (valid.length === 0) return new Map()

  const snaps = await db.getAll(...valid.map((path) => db.doc(path)))
  const names = new Map<string, string>()
  for (const snap of snaps) {
    const name = snap.data()?.name
    if (typeof name === 'string') names.set(snap.ref.path, name)
  }
  return names
}

/** Null for an unknown or revoked token, and for a trip that no longer exists. */
export async function loadSharedTripView(
  token: string,
): Promise<SharedTripView | null> {
  const tripId = await resolveShareToken(token)
  if (!tripId) return null

  const db = getFirestore()
  const tripRef = db.collection('trips').doc(tripId)
  const [tripSnap, daysSnap, stopsSnap, logSnap] = await Promise.all([
    tripRef.get(),
    tripRef.collection('days').orderBy('date').get(),
    tripRef.collection('corridorStops').get(),
    tripRef.collection('log').orderBy('createdAt').get(),
  ])
  if (!tripSnap.exists) return null
  const trip = tripSnap.data() as Trip

  const days: SharedTripDay[] = await Promise.all(
    daysSnap.docs.map(async (dayDoc) => {
      const day = dayDoc.data() as TripDay
      const [activitiesSnap, restaurantsSnap] = await Promise.all([
        dayDoc.ref.collection('activities').get(),
        dayDoc.ref.collection('restaurants').get(),
      ])
      return {
        id: dayDoc.id,
        index: day.index,
        date: day.date,
        type: day.type,
        summary: day.summary,
        ...(day.highlightReason ?? day.extraTimeReason
          ? { highlightReason: day.highlightReason ?? day.extraTimeReason }
          : {}),
        overnight: day.overnight,
        ...(day.drive ? { drive: day.drive } : {}),
        activities: activitiesSnap.docs
          .filter((doc) => isVisibleToGuests(doc.data() as Activity))
          .map((doc) => toSharedPlace(doc.id, doc.data() as Activity)),
        restaurants: restaurantsSnap.docs
          .filter((doc) => isVisibleToGuests(doc.data() as Restaurant))
          .map((doc) => toSharedPlace(doc.id, doc.data() as Restaurant)),
      }
    }),
  )

  // Ordered the way the route is actually driven — corridorStops carries no
  // sequence field of its own, so its linked days are the ordering key (the
  // same derivation OverviewMapScreen uses). Stops with no day yet sort last.
  const dayIndexById = new Map(days.map((day) => [day.id, day.index]))
  const corridorStops: SharedTripStop[] = stopsSnap.docs
    // A stop the travelers turned down is not part of their trip and never
    // renders anywhere — it only exists so a later refresh doesn't suggest
    // it again (see corridorStopStatusSchema). Dropped here rather than
    // shipped to a guest who has no way to see it: the view filters to
    // committed/locked anyway, so this is payload nobody reads.
    .filter((doc) => (doc.data() as CorridorStop).status !== 'rejected')
    .map((doc) => {
      const stop = doc.data() as CorridorStop
      return {
        stop: {
          id: doc.id,
          name: stop.name,
          lat: stop.lat,
          lng: stop.lng,
          ...(stop.country ? { country: stop.country } : {}),
          ...(stop.why ? { why: stop.why } : {}),
          status: stop.status,
        },
        order: stop.linkedDayIds.reduce(
          (min, dayId) => Math.min(min, dayIndexById.get(dayId) ?? Infinity),
          Infinity,
        ),
      }
    })
    .sort((a, b) => a.order - b.order)
    .map(({ stop }) => stop)

  const logEntries = logSnap.docs.map((doc) => ({
    id: doc.id,
    entry: doc.data() as LogEntry,
  }))
  const placeNames = await resolvePlaceNames(
    tripId,
    logEntries.map(({ entry }) => entry.refPath),
  )
  const diary: SharedTripDiaryEntry[] = logEntries.map(({ id, entry }) => ({
    id,
    date: entry.date,
    refType: entry.refType,
    // A place deleted since it was logged still deserves its diary line —
    // the traveler's own note is the part relatives came to read.
    placeName: placeNames.get(entry.refPath) ?? 'A stop on the trip',
    ...(entry.note ? { note: entry.note } : {}),
    createdAt: entry.createdAt,
  }))

  return {
    trip: {
      name: trip.meta.name,
      startDate: trip.settings.startDate,
      endDate: trip.settings.endDate,
      startPoint: trip.settings.startPoint,
      endPoint: trip.settings.endPoint,
      planStatus: trip.planMeta.status,
      /**
       * Measured from the days being SHOWN, not read off `planMeta`.
       *
       * `planMeta.totalKm` and `avgDriveMinutesPerDay` are written by a full
       * generation and by nothing else — relics of the plan-as-a-frozen-
       * artefact model. Under the dynamic one the day list is re-derived from
       * the board whenever the board changes, so those numbers describe a
       * plan that may no longer exist: a trip built entirely from locked
       * stops has never had them written at all, and a trip generated in July
       * still reports July's total however much has changed since.
       *
       * The days carry real Google distances and times per leg (see
       * PackedDay.driveKm), so the honest answer is simply their sum —
       * which is by construction the trip a relative is looking at.
       */
      ...summariseDrives(days),
      ...(trip.planMeta.generatedAt
        ? { generatedAt: trip.planMeta.generatedAt }
        : {}),
    },
    days,
    corridorStops,
    diary,
    fetchedAt: new Date().toISOString(),
  }
}

export const viewSharedTrip = onRequest(async (request, response) => {
  // The link is meant to be opened by anyone the travelers send it to, and
  // the response carries nothing beyond what the token itself entitles the
  // holder to. No cookie or Authorization header is involved, so a wildcard
  // origin grants a page nothing it couldn't get by fetching the URL
  // server-side anyway.
  response.set('Access-Control-Allow-Origin', '*')
  response.set('Access-Control-Allow-Methods', 'GET, OPTIONS')
  response.set('Access-Control-Max-Age', '3600')
  // Never cached anywhere: the whole point is that relatives see the trip as
  // it is right now, and a revoked link has to stop working immediately
  // rather than when some intermediary's TTL happens to expire.
  response.set('Cache-Control', 'no-store')

  if (request.method === 'OPTIONS') {
    response.status(204).send('')
    return
  }
  if (request.method !== 'GET') {
    response.status(405).json({ error: 'method-not-allowed' })
    return
  }

  const token = request.query.token
  if (typeof token !== 'string' || !token) {
    response.status(400).json({ error: 'token-required' })
    return
  }

  const view = await loadSharedTripView(token)
  if (!view) {
    // Unknown, revoked and deleted-trip all answer identically — telling a
    // caller which one it was would confirm that a token they guessed once
    // existed.
    response.status(404).json({ error: 'not-found' })
    return
  }

  response.status(200).json(view)
})

/**
 * Total driving and the daily average, from the days themselves.
 *
 * Both fields are omitted when there is nothing to measure — a trip with no
 * driving days yet should show no distance rather than a confident zero.
 */
function summariseDrives(days: { drive?: { distanceKm: number; durationMin: number } }[]): {
  totalKm?: number
  avgDriveMinutesPerDay?: number
} {
  const drives = days
    .map((day) => day.drive)
    .filter((drive): drive is { distanceKm: number; durationMin: number } => !!drive)
  if (drives.length === 0) return {}
  const totalKm = drives.reduce((sum, drive) => sum + drive.distanceKm, 0)
  const totalMin = drives.reduce((sum, drive) => sum + drive.durationMin, 0)
  return {
    ...(totalKm > 0 ? { totalKm } : {}),
    avgDriveMinutesPerDay: totalMin / drives.length,
  }
}
