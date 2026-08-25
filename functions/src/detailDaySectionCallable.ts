import Anthropic from '@anthropic-ai/sdk'
import { FieldValue, getFirestore } from 'firebase-admin/firestore'
import { HttpsError, onCall } from 'firebase-functions/https'
import {
  activitySchema,
  restaurantSchema,
  type DaySection,
  type Meal,
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
import { claudeApiKey, generateDaySection } from './prompts/planTrip.js'
import {
  SECTION_ACTIVITY_COUNT,
  SECTION_RESTAURANT_COUNT,
} from './prompts/daySectionPrompt.js'

/**
 * Fills one section of one day, because someone asked for that section.
 *
 * Requested 2026-08-25, as the third part of making the day list dynamic:
 * "the content could be generated for it with a click on that empty header
 * (lunch) for instance."
 *
 * It is not a smaller `detailDays`, and the differences are the point:
 *
 *  - **It never touches `detailStatus`.** That field means "the whole day
 *    has been detailed", and a day with only its lunch filled is not that.
 *    Marking it ready would also stop the whole-day pass from ever running.
 *    More importantly it is what `planSkeleton` refuses to rebuild over, and
 *    the entire reason this exists is that a day list which freezes the
 *    moment you LOOK at a day is not dynamic. Looking is now free; asking is
 *    what costs.
 *  - **It records `filledSections` instead**, which is the signal that this
 *    day now carries something paid for. `planSkeleton` reads it and holds
 *    off, so a click here is protected exactly as a full generation is.
 *  - **It replaces only its own scope.** `detailDays` clears a day's
 *    activities AND restaurants before writing, which is right for a
 *    whole-day pass and would silently destroy the other three sections
 *    here.
 *
 * Deterministic document ids (`activity-0`, `lunch-1`) rather than
 * `collection().doc()`: two taps that race would otherwise each delete the
 * old scope and then add its own three, leaving six. With fixed ids the
 * second run overwrites the first and the count is whatever was asked for.
 */
export const detailDaySection = onCall(
  { secrets: [claudeApiKey, googlePlacesApiKey], timeoutSeconds: 300 },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError('unauthenticated', 'Must be signed in')
    }
    requireAccess(request.auth)

    const tripId = request.data?.tripId
    const dayId = request.data?.dayId
    const kind = request.data?.kind as 'activity' | 'restaurant' | undefined
    const meal = request.data?.meal as Meal | undefined
    if (
      typeof tripId !== 'string' ||
      typeof dayId !== 'string' ||
      (kind !== 'activity' && kind !== 'restaurant')
    ) {
      throw new HttpsError(
        'invalid-argument',
        'tripId, dayId and kind ("activity" | "restaurant") are required',
      )
    }
    if (kind === 'restaurant' && !meal) {
      throw new HttpsError(
        'invalid-argument',
        'a meal is required when asking for restaurants',
      )
    }
    await requireTripMember(tripId, request.auth.uid)
    return runDetailDaySection(tripId, dayId, kind, meal)
  },
)

/**
 * The work, without the auth wrapper — so the tests can drive it against the
 * real emulator the way runDetailDays already is.
 */
export async function runDetailDaySection(
  tripId: string,
  dayId: string,
  kind: 'activity' | 'restaurant',
  meal?: Meal,
): Promise<{ section: DaySection; written: number }> {
  {
    const db = getFirestore()
    const tripRef = db.collection('trips').doc(tripId)
    const [tripSnap, daysSnap] = await Promise.all([
      tripRef.get(),
      tripRef.collection('days').get(),
    ])
    const trip = tripSnap.data() as Trip | undefined
    if (!trip) throw new HttpsError('not-found', 'Trip not found')

    const all = daysSnap.docs.map((doc) => ({
      ref: doc.ref,
      day: doc.data() as TripDay,
    }))
    const target = all.find((entry) => entry.ref.id === dayId)
    if (!target) throw new HttpsError('not-found', 'Day not found on this trip')

    // A whole-day run owns the day while it is generating, and would clear
    // whatever this wrote on its way past.
    if (target.day.detailStatus === 'generating') {
      throw new HttpsError(
        'failed-precondition',
        'This day is already being filled in — try again in a moment.',
      )
    }

    const section: DaySection = kind === 'activity' ? 'activity' : meal!
    const outline = outlineFromDays(all.map((entry) => entry.day))
    const outlineDay = outline.days.find((d) => d.index === target.day.index)
    if (!outlineDay) {
      throw new HttpsError('internal', 'That day is missing from the outline')
    }

    // What is already suggested on this day, across every section — so a
    // lunch request cannot hand back the café already sitting under
    // breakfast.
    const [activitiesSnap, restaurantsSnap] = await Promise.all([
      target.ref.collection('activities').get(),
      target.ref.collection('restaurants').get(),
    ])
    const existingNames = [
      ...activitiesSnap.docs.map((d) => String(d.data().name)),
      ...restaurantsSnap.docs.map((d) => String(d.data().name)),
    ]

    const client = new Anthropic({ apiKey: claudeApiKey.value() })
    let proposed
    try {
      proposed = await generateDaySection(
        client,
        {
          settings: trip.settings,
          notesFreeText: trip.notes.freeText,
          day: outlineDay,
          kind,
          meal,
          existingNames,
        },
        { tripId },
      )
    } catch (error) {
      console.error(`detailDaySection failed for trip ${tripId}`, error)
      throw new HttpsError(
        'internal',
        `Could not fill that in: ${describeCause(error)}`,
      )
    }

    // Verified through Places exactly as the whole-day path is — which is
    // where the photo and the listing link come from, and what keeps a
    // proposed name from being a place that does not exist.
    const { activities, restaurants } = await enrichDayDetail(
      {
        activities: (proposed.activities ?? []).slice(
          0,
          SECTION_ACTIVITY_COUNT,
        ),
        restaurants: (proposed.restaurants ?? []).slice(
          0,
          SECTION_RESTAURANT_COUNT,
        ),
      },
      anchorFor(target.day, all, trip),
    )

    const writes: PendingWrite[] = []
    if (kind === 'activity') {
      activitiesSnap.docs.forEach((doc) =>
        writes.push({ op: 'delete', ref: doc.ref }),
      )
      activities.forEach((activity, index) => {
        activitySchema.parse(activity)
        writes.push({
          op: 'set',
          ref: target.ref.collection('activities').doc(`activity-${index}`),
          data: activity,
        })
      })
    } else {
      // Only this meal's restaurants — the other two sections are somebody
      // else's answer to somebody else's question.
      restaurantsSnap.docs
        .filter((doc) => doc.data().meal === meal)
        .forEach((doc) => writes.push({ op: 'delete', ref: doc.ref }))
      restaurants
        .filter((restaurant) => restaurant.meal === meal)
        .forEach((restaurant, index) => {
          restaurantSchema.parse(restaurant)
          writes.push({
            op: 'set',
            ref: target.ref.collection('restaurants').doc(`${meal}-${index}`),
            data: restaurant,
          })
        })
    }

    writes.push({
      op: 'set',
      options: { merge: true },
      ref: target.ref,
      data: {
        filledSections: FieldValue.arrayUnion(section),
        detailError: FieldValue.delete(),
      },
    })

    await commitInChunks(db, writes)

    return {
      section,
      written: kind === 'activity' ? activities.length : restaurants.length,
    }
  }
}

/** Same anchor the whole-day pass uses — see detailDaysCallable's copy. */
function anchorFor(
  day: TripDay,
  all: { day: TripDay }[],
  trip: Trip,
): { lat: number; lng: number } {
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
