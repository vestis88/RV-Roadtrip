import { getFirestore } from 'firebase-admin/firestore'
import { onDocumentCreated } from 'firebase-functions/firestore'
import {
  activitySchema,
  restaurantSchema,
  tripDaySchema,
  type Activity,
  type NamedPoint,
  type Restaurant,
  type TripDay,
} from '@rv/shared'
import { validatePacing } from './pacingValidator.js'
import { runReplan, type ReplanContext } from './replanTrip.js'
import { computeMultiLegTotals, googleRoutesApiKey } from './routesApi.js'

interface PlanRequestData {
  tripId: string
  kind: 'full' | 'replan'
  replanContext?: ReplanContext
  status: string
}

interface FixtureDay {
  day: Omit<TripDay, 'drive'> & { drive?: TripDay['drive'] }
  activities: Activity[]
  restaurants: Restaurant[]
}

const FIXTURE_WAYPOINTS: NamedPoint[] = [
  { name: 'Oslo', lat: 59.9139, lng: 10.7522 },
  { name: 'Lillehammer', lat: 61.1153, lng: 10.4662 },
  { name: 'Otta', lat: 61.7725, lng: 9.5406 },
]

async function fixturePlan(): Promise<FixtureDay[]> {
  const { legs } = await computeMultiLegTotals(FIXTURE_WAYPOINTS)

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
          distanceKm: legs[0].distanceKm,
          durationMin: legs[0].durationMin,
          slot: 'morning',
          ...(legs[0].polyline ? { polyline: legs[0].polyline } : {}),
        },
        summary: 'Easy first day north along the Mjøsa lake.',
      },
      activities: [
        {
          name: 'Maihaugen Open-Air Museum',
          category: 'museum',
          lat: 61.1147,
          lng: 10.4726,
          googleMapsUrl: 'https://maps.google.com/?q=Maihaugen+Open-Air+Museum',
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
          googleMapsUrl: 'https://maps.google.com/?q=Bryggerikjelleren',
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
          distanceKm: legs[1].distanceKm,
          durationMin: legs[1].durationMin,
          slot: 'midday',
          ...(legs[1].polyline ? { polyline: legs[1].polyline } : {}),
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
  { document: 'planRequests/{requestId}', secrets: [googleRoutesApiKey] },
  async (event) => {
    const snap = event.data
    if (!snap) return

    const request = snap.data() as PlanRequestData
    const db = getFirestore()
    const tripRef = db.collection('trips').doc(request.tripId)

    if (request.kind === 'replan') {
      if (!request.replanContext) {
        await tripRef.update({
          'planMeta.status': 'error',
          'planMeta.error': 'replan request is missing replanContext',
        })
        await snap.ref.update({
          status: 'error',
          error: 'replan request is missing replanContext',
        })
        return
      }
      try {
        await runReplan(request.tripId, request.replanContext)
        await snap.ref.update({ status: 'done' })
      } catch (error) {
        console.error('runReplan failed', error)
        await tripRef.update({
          'planMeta.status': 'error',
          'planMeta.error': String(error),
        })
        await snap.ref.update({ status: 'error', error: String(error) })
      }
      return
    }

    try {
      await tripRef.update({ 'planMeta.status': 'pending' })
      await tripRef.update({ 'planMeta.status': 'generating' })

      const days = await fixturePlan()

      // Section 5 pacing rules: no day > 1.4x target, final 2 days <= 1.0x
      // target, rest days stay put. planTrip (T-14) isn't wired into this
      // fixture pipeline yet, so there's nothing to feed a retry back to —
      // this is the "never show a bad plan" backstop that T-16/T-17 will
      // extend into a real one-shot retry once Claude drives the content.
      const violation = validatePacing(days.map((d) => d.day))
      if (violation) {
        throw new Error(`Pacing validation failed: ${violation.reason}`)
      }

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
      console.error('generatePlan failed', error)
      await tripRef.update({
        'planMeta.status': 'error',
        'planMeta.error': String(error),
      })
      await snap.ref.update({ status: 'error', error: String(error) })
    }
  },
)
