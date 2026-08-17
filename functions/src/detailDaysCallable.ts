import Anthropic from '@anthropic-ai/sdk'
import {
  FieldValue,
  getFirestore,
  type DocumentReference,
} from 'firebase-admin/firestore'
import { HttpsError, onCall } from 'firebase-functions/https'
import {
  MAX_DETAIL_WINDOW_DAYS,
  activitySchema,
  detailWindowDaysOf,
  restaurantSchema,
  type Trip,
  type TripDay,
} from '@rv/shared'
import { requireAccess } from './accessControl.js'
import { requireTripMember } from './authz.js'
import { describeCause } from './describeCause.js'
import { outlineFromDays } from './dayOutline.js'
import { commitInChunks, type PendingWrite } from './firestoreBatch.js'
import { googlePlacesApiKey } from './placesApi.js'
import { dayActivityAnchor, enrichDayDetail } from './dayDetail.js'
import { claudeApiKey, generateChunkDetail } from './prompts/planTrip.js'

/**
 * How often a run in progress says it is still alive.
 *
 * Same reasoning as the rescan's own heartbeat: a status written once at the
 * start cannot tell a slow run from a container that died two minutes ago,
 * so the only safe reading is "assume alive" and the day sits behind a
 * spinner forever.
 */
const DETAIL_HEARTBEAT_MS = 20_000

/** A day this request is responsible for, with what it needs to resolve it. */
interface ClaimedDay {
  ref: DocumentReference
  day: TripDay
}

/**
 * Works out the activities and restaurants for a window of days.
 *
 * The lazy half of "route eagerly, detail lazily". The route for every day
 * of the trip already exists — dates, overnight towns, drive legs, the
 * sights each day was routed for — and this fills in what a day is actually
 * made of, for the day being opened and the couple after it.
 *
 * Claude is given the WHOLE route as context and asked to elaborate only on
 * the window, which is exactly what the detail phase has always done at
 * generation time (see buildChunkDetailPrompt). The difference is only when
 * it runs, so the outline is reconstructed from the stored days rather than
 * handed over from the call that produced it — see outlineFromDays.
 *
 * Not routed through planRequests. A detail run writes only into a day's own
 * activities/restaurants subcollections: it cannot move the route, change a
 * date or touch the corridor, so the one-operation-per-trip busy guard that
 * exists to stop two replans corrupting each other would only block a
 * traveler from reading their trip while a replan runs. What it does need is
 * a per-DAY claim, so two devices opening overlapping windows cannot both
 * pay for the same day.
 */
export async function runDetailDays(
  tripId: string,
  fromDayId: string,
  // Omitted by every ordinary caller: how far ahead to work out is the
  // trip's own setting (Trip Setup's "Plan ahead" slider), and reading it
  // here rather than at the call site is what keeps the eager window and
  // this rolling one the same number. Passed explicitly only where a caller
  // genuinely means a specific count.
  count?: number,
): Promise<{ detailed: number; alreadyReady: number }> {
  const db = getFirestore()
  const tripRef = db.collection('trips').doc(tripId)
  const [tripSnap, daysSnap] = await Promise.all([
    tripRef.get(),
    tripRef.collection('days').orderBy('index').get(),
  ])
  if (!tripSnap.exists) {
    throw new HttpsError('not-found', 'Trip not found')
  }
  const trip = tripSnap.data() as Trip

  const all = daysSnap.docs.map((doc) => ({
    ref: doc.ref,
    day: doc.data() as TripDay,
  }))
  const startAt = all.findIndex((entry) => entry.ref.id === fromDayId)
  if (startAt === -1) {
    throw new HttpsError('not-found', 'Day not found on this trip')
  }

  // The window is positional — this day and the ones after it — but only the
  // days actually waiting are claimed. A day already detailed is left alone
  // rather than re-detailed, which is what makes opening day 4 after day 3
  // cost one day rather than three.
  const window = all.slice(startAt, startAt + (count ?? detailWindowDaysOf(trip.settings)))
  const pending = window.filter(
    (entry) => (entry.day.detailStatus ?? 'ready') === 'pending',
  )
  if (pending.length === 0) {
    return { detailed: 0, alreadyReady: window.length }
  }

  const claimed = await claim(db, pending)
  if (claimed.length === 0) {
    // Everything in the window was taken by another run between the read and
    // the claim. Not an error: that run is about to write exactly what this
    // one would have.
    return { detailed: 0, alreadyReady: window.length }
  }

  const heartbeat = setInterval(() => {
    const beat = new Date().toISOString()
    for (const entry of claimed) {
      void entry.ref
        .update({ detailStatusUpdatedAt: beat })
        .catch((error: unknown) =>
          console.warn('Detail heartbeat write failed', entry.ref.id, error),
        )
    }
  }, DETAIL_HEARTBEAT_MS)

  try {
    await detailClaimedDays(tripRef, trip, all, claimed)
    return { detailed: claimed.length, alreadyReady: window.length - claimed.length }
  } catch (error) {
    // Back to pending, with the reason attached where it outlives the
    // connection that asked for this — the alternative is a day stuck
    // 'generating' forever and a traveler with no idea why.
    const cause = describeCause(error)
    await Promise.all(
      claimed.map((entry) =>
        entry.ref
          .update({
            detailStatus: 'pending',
            detailError: cause,
            detailStatusUpdatedAt: new Date().toISOString(),
          })
          .catch((clearError: unknown) =>
            console.warn('Clearing detailStatus after a failed run failed', clearError),
          ),
      ),
    )
    console.error(`detailDays failed for trip ${tripId}`, error)
    throw new HttpsError('internal', `Could not plan those days: ${cause}`)
  } finally {
    clearInterval(heartbeat)
  }
}

/**
 * Takes ownership of each day that is still pending, one transaction per day.
 *
 * Per day rather than one transaction over the window on purpose: two
 * devices opening overlapping windows should each detail the half the other
 * did not, instead of one losing the whole batch to a single contended day.
 */
async function claim(
  db: FirebaseFirestore.Firestore,
  candidates: ClaimedDay[],
): Promise<ClaimedDay[]> {
  const claimed: ClaimedDay[] = []
  for (const entry of candidates) {
    const won = await db.runTransaction(async (tx) => {
      const snap = await tx.get(entry.ref)
      const day = snap.data() as TripDay | undefined
      if (!day || (day.detailStatus ?? 'ready') !== 'pending') return false
      tx.update(entry.ref, {
        detailStatus: 'generating',
        detailStatusUpdatedAt: new Date().toISOString(),
      })
      return true
    })
    if (won) claimed.push(entry)
  }
  return claimed
}

async function detailClaimedDays(
  tripRef: DocumentReference,
  trip: Trip,
  all: ClaimedDay[],
  claimed: ClaimedDay[],
): Promise<void> {
  const outline = outlineFromDays(all.map((entry) => entry.day))
  const byIndex = new Map(outline.days.map((day) => [day.index, day]))
  const chunkDays = claimed
    .map((entry) => byIndex.get(entry.day.index))
    .filter((day): day is NonNullable<typeof day> => day !== undefined)

  const client = new Anthropic({ apiKey: claudeApiKey.value() })
  const detail = await generateChunkDetail(
    client,
    {
      settings: trip.settings,
      notesFreeText: trip.notes.freeText,
      outline,
      chunkDays,
    },
    { tripId: tripRef.id, callType: 'detail' },
  )
  const detailByIndex = new Map(detail.days.map((day) => [day.index, day]))

  const writes: PendingWrite[] = []
  for (const entry of claimed) {
    const dayDetail = detailByIndex.get(entry.day.index)
    if (!dayDetail) {
      throw new Error(
        `Claude never returned detail for day index ${entry.day.index}`,
      )
    }

    const { activities, restaurants } = await enrichDayDetail(
      { activities: dayDetail.activities, restaurants: dayDetail.restaurants },
      anchorFor(entry.day, all, trip),
    )

    // A retry after a partial failure must not leave two sets of suggestions
    // side by side — the same reason writeGeneratedDays clears before it
    // writes.
    const [existingActivities, existingRestaurants] = await Promise.all([
      entry.ref.collection('activities').get(),
      entry.ref.collection('restaurants').get(),
    ])
    existingActivities.docs.forEach((doc) =>
      writes.push({ op: 'delete', ref: doc.ref }),
    )
    existingRestaurants.docs.forEach((doc) =>
      writes.push({ op: 'delete', ref: doc.ref }),
    )
    for (const activity of activities) {
      activitySchema.parse(activity)
      writes.push({
        op: 'set',
        ref: entry.ref.collection('activities').doc(),
        data: activity,
      })
    }
    for (const restaurant of restaurants) {
      restaurantSchema.parse(restaurant)
      writes.push({
        op: 'set',
        ref: entry.ref.collection('restaurants').doc(),
        data: restaurant,
      })
    }
    writes.push({
      // Merge-set rather than a plain set: everything else on the day is the
      // route, and this run has no business rewriting it.
      op: 'set',
      options: { merge: true },
      ref: entry.ref,
      data: {
        // The real summary replaces the outline sentence that stood in for
        // it — see generateSkeletonFromHighlights.
        summary: dayDetail.summary,
        ...(dayDetail.extraTimeReason
          ? { extraTimeReason: dayDetail.extraTimeReason }
          : {}),
        detailStatus: 'ready',
        detailStatusUpdatedAt: new Date().toISOString(),
        detailError: FieldValue.delete(),
      },
    })
  }

  await commitInChunks(getFirestore(), writes)
}

/**
 * Where this day's activities and restaurants should be searched for.
 *
 * Mirrors what generation does, through the same helper, because the rule is
 * not obvious: on the default 'evening' drive slot the day is actually spent
 * in the town it STARTED in, and the new overnight is only reached once
 * everything else is done. `townAnchor` is the day's own town (as opposed to
 * the field the night was eventually moved to); the previous day's is where
 * this one began.
 */
function anchorFor(day: TripDay, all: ClaimedDay[], trip: Trip) {
  const previous = all.find((entry) => entry.day.index === day.index - 1)?.day
  const townPoint = day.townAnchor ?? {
    lat: day.overnight.lat,
    lng: day.overnight.lng,
  }
  const arrivedFrom = previous
    ? (previous.townAnchor ?? {
        lat: previous.overnight.lat,
        lng: previous.overnight.lng,
      })
    : { lat: trip.settings.startPoint.lat, lng: trip.settings.startPoint.lng }
  return dayActivityAnchor({
    type: day.type,
    driveSlot: day.drive?.slot,
    townPoint,
    arrivedFrom,
  })
}

export const detailDays = onCall(
  {
    secrets: [claudeApiKey, googlePlacesApiKey],
    // One short Claude call for the window plus a handful of Places lookups
    // per day — a fraction of what the whole-trip detail phase cost, which
    // is the point. Generous anyway: the traveler is sitting in front of the
    // day they just opened.
    timeoutSeconds: 180,
  },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError('unauthenticated', 'Must be signed in')
    }
    requireAccess(request.auth)
    const tripId = request.data?.tripId
    const fromDayId = request.data?.fromDayId
    // Absent means "whatever this trip's own window is" — resolved inside
    // runDetailDays, which has the trip. Validated against the hard ceiling
    // rather than against that setting, because this is the bound that stops
    // a hand-written request asking for a hundred days of paid work.
    const count = request.data?.count
    if (typeof tripId !== 'string' || typeof fromDayId !== 'string') {
      throw new HttpsError('invalid-argument', 'tripId and fromDayId are required')
    }
    if (
      count !== undefined &&
      (typeof count !== 'number' ||
        !Number.isInteger(count) ||
        count < 1 ||
        count > MAX_DETAIL_WINDOW_DAYS)
    ) {
      throw new HttpsError(
        'invalid-argument',
        `count must be a whole number between 1 and ${MAX_DETAIL_WINDOW_DAYS}`,
      )
    }
    await requireTripMember(tripId, request.auth.uid)
    return runDetailDays(tripId, fromDayId, count)
  },
)
