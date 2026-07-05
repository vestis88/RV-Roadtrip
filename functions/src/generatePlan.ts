import { getFirestore } from 'firebase-admin/firestore'
import { onDocumentCreated } from 'firebase-functions/firestore'
import {
  activitySchema,
  restaurantSchema,
  tripDaySchema,
  type Activity,
  type Restaurant,
  type TripDay,
} from '@rv/shared'

interface PlanRequestData {
  tripId: string
  kind: 'full' | 'replan'
  status: string
}

interface FixtureDay {
  day: TripDay
  activities: Activity[]
  restaurants: Restaurant[]
}

function fixturePlan(): FixtureDay[] {
  return [
    {
      day: {
        index: 0,
        date: '2026-07-10',
        type: 'drive',
        overnight: {
          name: 'Lillehammer Camping',
          lat: 61.1153,
          lng: 10.4662,
          country: 'NO',
          campsiteSuggestion: 'Lillehammer Camping',
        },
        drive: {
          fromName: 'Oslo',
          toName: 'Lillehammer',
          distanceKm: 180,
          durationMin: 150,
          slot: 'morning',
        },
        summary: 'Easy first day north along the Mjøsa lake.',
      },
      activities: [
        {
          name: 'Maihaugen Open-Air Museum',
          category: 'museum',
          lat: 61.1147,
          lng: 10.4726,
          blurb: 'A hidden-gem open-air museum the kids will love.',
          kidFriendly: true,
          status: 'suggested',
        },
      ],
      restaurants: [
        {
          name: 'Bryggerikjelleren',
          meal: 'dinner',
          lat: 61.1123,
          lng: 10.4661,
          blurb: 'Cozy cellar restaurant near the river.',
          status: 'suggested',
        },
      ],
    },
    {
      day: {
        index: 1,
        date: '2026-07-11',
        type: 'drive',
        overnight: {
          name: 'Otta Camping',
          lat: 61.7725,
          lng: 9.5406,
          country: 'NO',
          campsiteSuggestion: 'Otta Camping',
        },
        drive: {
          fromName: 'Lillehammer',
          toName: 'Otta',
          distanceKm: 140,
          durationMin: 120,
          slot: 'midday',
        },
        summary: 'Into the mountains along the Gudbrandsdalen valley.',
      },
      activities: [
        {
          name: 'Rondane National Park hike',
          category: 'hike',
          lat: 61.85,
          lng: 9.85,
          blurb: 'A gentle family hike with sweeping mountain views.',
          kidFriendly: true,
          status: 'suggested',
        },
      ],
      restaurants: [
        {
          name: 'Otta Café',
          meal: 'lunch',
          lat: 61.7719,
          lng: 9.541,
          blurb: 'Simple local café, good stop before the trail.',
          status: 'suggested',
        },
      ],
    },
    {
      day: {
        index: 2,
        date: '2026-07-12',
        type: 'rest',
        overnight: {
          name: 'Otta Camping',
          lat: 61.7725,
          lng: 9.5406,
          country: 'NO',
          campsiteSuggestion: 'Otta Camping',
        },
        summary: 'Rest day in Otta — no driving today.',
      },
      activities: [
        {
          name: 'Sjoa river rafting',
          category: 'other',
          lat: 61.68,
          lng: 9.55,
          blurb: 'A splash of adventure on a rest day.',
          kidFriendly: false,
          status: 'suggested',
        },
      ],
      restaurants: [
        {
          name: 'Peer Gynt Gård',
          meal: 'dinner',
          lat: 61.71,
          lng: 9.6,
          blurb: 'Farmhouse restaurant with local produce.',
          status: 'suggested',
        },
      ],
    },
  ]
}

export const generatePlan = onDocumentCreated(
  'planRequests/{requestId}',
  async (event) => {
    const snap = event.data
    if (!snap) return

    const request = snap.data() as PlanRequestData
    const db = getFirestore()
    const tripRef = db.collection('trips').doc(request.tripId)

    try {
      await tripRef.update({ 'planMeta.status': 'pending' })
      await tripRef.update({ 'planMeta.status': 'generating' })

      const days = fixturePlan()
      const batch = db.batch()
      for (const { day, activities, restaurants } of days) {
        tripDaySchema.parse(day)
        const dayRef = tripRef.collection('days').doc(day.date)
        batch.set(dayRef, day)
        for (const activity of activities) {
          activitySchema.parse(activity)
          batch.set(dayRef.collection('activities').doc(), activity)
        }
        for (const restaurant of restaurants) {
          restaurantSchema.parse(restaurant)
          batch.set(dayRef.collection('restaurants').doc(), restaurant)
        }
      }
      await batch.commit()

      const driveDays = days.filter((d) => d.day.drive)
      const totalKm = driveDays.reduce(
        (sum, d) => sum + (d.day.drive?.distanceKm ?? 0),
        0,
      )
      const avgDriveMinutesPerDay = driveDays.length
        ? driveDays.reduce(
            (sum, d) => sum + (d.day.drive?.durationMin ?? 0),
            0,
          ) / driveDays.length
        : 0

      await tripRef.update({
        'planMeta.status': 'ready',
        'planMeta.totalKm': totalKm,
        'planMeta.avgDriveMinutesPerDay': avgDriveMinutesPerDay,
        'planMeta.generatedAt': new Date().toISOString(),
      })
      await snap.ref.update({ status: 'done' })
    } catch (error) {
      await tripRef.update({
        'planMeta.status': 'error',
        'planMeta.error': String(error),
      })
      await snap.ref.update({ status: 'error', error: String(error) })
    }
  },
)
