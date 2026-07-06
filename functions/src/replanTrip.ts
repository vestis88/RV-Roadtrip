import { getFirestore } from 'firebase-admin/firestore'
import {
  activitySchema,
  restaurantSchema,
  tripDaySchema,
  type Activity,
  type LatLng,
  type NamedPoint,
  type Restaurant,
  type TripDay,
} from '@rv/shared'
import { computeMultiLegTotals } from './routesApi.js'
import { validatePacing } from './pacingValidator.js'

export interface ReplanContext {
  currentLocation: LatLng
  today: string
  completedRefPaths: string[]
  remainingEndDate: string
  remainingEndPoint: NamedPoint
  changeRequestText?: string
  lockedDayIds?: string[]
}

interface FixtureDay {
  day: TripDay
  activities: Activity[]
  restaurants: Restaurant[]
}

/**
 * Builds a minimal remainder itinerary from today's location to the
 * remaining end point. This is a stand-in for the real day-by-day Claude
 * generation (T-14), which isn't wired into this pipeline yet — same
 * caveat as generatePlan's fixture. It's enough to prove replanTrip's own
 * job: preserving past days and re-pacing only what's left.
 */
async function buildRemainderFixture(
  context: ReplanContext,
  startIndex: number,
): Promise<FixtureDay[]> {
  const from: NamedPoint = {
    name: 'Current location',
    lat: context.currentLocation.lat,
    lng: context.currentLocation.lng,
  }
  const { legs } = await computeMultiLegTotals([from, context.remainingEndPoint])
  const leg = legs[0]

  const driveDay: FixtureDay = {
    day: {
      index: startIndex,
      date: context.today,
      type: 'drive',
      overnight: {
        name: context.remainingEndPoint.name,
        lat: context.remainingEndPoint.lat,
        lng: context.remainingEndPoint.lng,
        country: 'NO',
      },
      drive: {
        fromName: from.name,
        toName: context.remainingEndPoint.name,
        distanceKm: leg.distanceKm,
        durationMin: leg.durationMin,
        slot: 'morning',
      },
      summary: 'Re-planned leg to the finish.',
    },
    activities: [
      {
        name: 'Local viewpoint',
        category: 'sight',
        lat: context.remainingEndPoint.lat,
        lng: context.remainingEndPoint.lng,
        blurb: 'A worthwhile stop along the re-planned route.',
        kidFriendly: true,
        status: 'suggested',
      },
    ],
    restaurants: [
      {
        name: 'Roadside restaurant',
        meal: 'dinner',
        lat: context.remainingEndPoint.lat,
        lng: context.remainingEndPoint.lng,
        blurb: 'Convenient dinner stop at the end of the day.',
        status: 'suggested',
      },
    ],
  }

  const days = [driveDay]

  if (context.remainingEndDate !== context.today) {
    days.push({
      day: {
        index: startIndex + 1,
        date: context.remainingEndDate,
        type: 'rest',
        overnight: {
          name: context.remainingEndPoint.name,
          lat: context.remainingEndPoint.lat,
          lng: context.remainingEndPoint.lng,
          country: 'NO',
        },
        summary: 'Rest day at the finish — no driving today.',
      },
      activities: [
        {
          name: 'Town square stroll',
          category: 'sight',
          lat: context.remainingEndPoint.lat,
          lng: context.remainingEndPoint.lng,
          blurb: 'Easy wandering to close out the trip.',
          kidFriendly: true,
          status: 'suggested',
        },
      ],
      restaurants: [
        {
          name: 'Celebration dinner spot',
          meal: 'dinner',
          lat: context.remainingEndPoint.lat,
          lng: context.remainingEndPoint.lng,
          blurb: 'A nice place to mark the end of the trip.',
          status: 'suggested',
        },
      ],
    })
  }

  return days
}

export async function runReplan(
  tripId: string,
  context: ReplanContext,
): Promise<void> {
  const db = getFirestore()
  const tripRef = db.collection('trips').doc(tripId)

  await tripRef.update({ 'planMeta.status': 'pending' })
  await tripRef.update({ 'planMeta.status': 'generating' })

  const lockedDayIds = new Set(context.lockedDayIds ?? [])
  const daysSnap = await tripRef.collection('days').orderBy('date').get()
  // Past days are historical fact; locked days were explicitly pinned by the
  // user via the "Request changes" flow. Both survive the replan untouched.
  const pastDocs = daysSnap.docs.filter(
    (doc) =>
      (doc.data() as TripDay).date < context.today || lockedDayIds.has(doc.id),
  )
  const futureDocs = daysSnap.docs.filter(
    (doc) =>
      (doc.data() as TripDay).date >= context.today && !lockedDayIds.has(doc.id),
  )

  for (const doc of futureDocs) {
    const [activities, restaurants] = await Promise.all([
      doc.ref.collection('activities').get(),
      doc.ref.collection('restaurants').get(),
    ])
    const deleteBatch = db.batch()
    activities.docs.forEach((a) => deleteBatch.delete(a.ref))
    restaurants.docs.forEach((r) => deleteBatch.delete(r.ref))
    deleteBatch.delete(doc.ref)
    await deleteBatch.commit()
  }

  const remainder = await buildRemainderFixture(context, pastDocs.length)

  const writeBatch = db.batch()
  for (const { day, activities, restaurants } of remainder) {
    tripDaySchema.parse(day)
    const dayRef = tripRef.collection('days').doc(day.date)
    writeBatch.set(dayRef, day)
    for (const activity of activities) {
      activitySchema.parse(activity)
      writeBatch.set(dayRef.collection('activities').doc(), activity)
    }
    for (const restaurant of restaurants) {
      restaurantSchema.parse(restaurant)
      writeBatch.set(dayRef.collection('restaurants').doc(), restaurant)
    }
  }
  await writeBatch.commit()

  // Past days are historical fact and can't be re-paced; per 6.2, only the
  // regenerated remainder needs to satisfy Section 5's pacing rules.
  const remainderDays = remainder.map((r) => r.day)
  const violation = validatePacing(remainderDays)
  if (violation) {
    throw new Error(`Pacing validation failed: ${violation.reason}`)
  }

  const allDays: TripDay[] = [
    ...pastDocs.map((doc) => doc.data() as TripDay),
    ...remainderDays,
  ]

  const driveDays = allDays.filter((day) => day.drive)
  const totalKm = driveDays.reduce(
    (sum, day) => sum + (day.drive?.distanceKm ?? 0),
    0,
  )
  const avgDriveMinutesPerDay = driveDays.length
    ? driveDays.reduce((sum, day) => sum + (day.drive?.durationMin ?? 0), 0) /
      driveDays.length
    : 0

  const now = new Date().toISOString()
  await tripRef.update({
    'planMeta.status': 'ready',
    'planMeta.totalKm': totalKm,
    'planMeta.avgDriveMinutesPerDay': avgDriveMinutesPerDay,
    'planMeta.generatedAt': now,
    'planMeta.lastReplanAt': now,
  })
}
