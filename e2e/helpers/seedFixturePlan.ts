import type { Page } from '@playwright/test'
import { getApps, initializeApp } from 'firebase-admin/app'
import { getFirestore } from 'firebase-admin/firestore'

process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:8080'
const PROJECT_ID = 'demo-rv-trip-planner'
if (getApps().length === 0) initializeApp({ projectId: PROJECT_ID })
const adminDb = getFirestore()

// generatePlan (T-14/T-16) now runs the real Claude + Places pipeline with
// no synthetic fallback (by design — same as the rest of that pipeline),
// so it can't produce a deterministic plan in this credential-less
// emulator. This reproduces the exact 3-day Oslo → Lillehammer → Otta plan
// generatePlan used to hardcode as its own fixture, written directly via
// firebase-admin so E2E specs that only care about downstream screens
// (map, day view, diary, countries, etc.) don't need real API keys either.
const FIXTURE_DAYS = [
  {
    day: {
      index: 0,
      date: '2026-07-10',
      type: 'drive' as const,
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
        slot: 'morning' as const,
      },
      summary: 'Easy first day north along the Mjøsa lake.',
    },
    activities: [
      {
        name: 'Maihaugen Open-Air Museum',
        category: 'museum' as const,
        lat: 61.1147,
        lng: 10.4726,
        googleMapsUrl: 'https://maps.google.com/?q=Maihaugen+Open-Air+Museum',
        blurb: 'A hidden-gem open-air museum the kids will love.',
        kidFriendly: true,
        status: 'suggested' as const,
      },
    ],
    restaurants: [
      {
        name: 'Bryggerikjelleren',
        meal: 'dinner' as const,
        lat: 61.1123,
        lng: 10.4661,
        googleMapsUrl: 'https://maps.google.com/?q=Bryggerikjelleren',
        blurb: 'Cozy cellar restaurant near the river.',
        status: 'suggested' as const,
      },
    ],
  },
  {
    day: {
      index: 1,
      date: '2026-07-11',
      type: 'drive' as const,
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
        slot: 'midday' as const,
      },
      summary: 'Into the mountains along the Gudbrandsdalen valley.',
    },
    activities: [
      {
        name: 'Rondane National Park hike',
        category: 'hike' as const,
        lat: 61.85,
        lng: 9.85,
        blurb: 'A gentle family hike with sweeping mountain views.',
        kidFriendly: true,
        status: 'suggested' as const,
      },
    ],
    restaurants: [
      {
        name: 'Otta Café',
        meal: 'lunch' as const,
        lat: 61.7719,
        lng: 9.541,
        blurb: 'Simple local café, good stop before the trail.',
        status: 'suggested' as const,
      },
    ],
  },
  {
    day: {
      index: 2,
      date: '2026-07-12',
      type: 'rest' as const,
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
        category: 'other' as const,
        lat: 61.68,
        lng: 9.55,
        blurb: 'A splash of adventure on a rest day.',
        kidFriendly: false,
        status: 'suggested' as const,
      },
    ],
    restaurants: [
      {
        name: 'Peer Gynt Gård',
        meal: 'dinner' as const,
        lat: 61.71,
        lng: 9.6,
        blurb: 'Farmhouse restaurant with local produce.',
        status: 'suggested' as const,
      },
    ],
  },
]

export async function seedFixturePlan(tripId: string): Promise<void> {
  const tripRef = adminDb.collection('trips').doc(tripId)
  const batch = adminDb.batch()

  for (const { day, activities, restaurants } of FIXTURE_DAYS) {
    const dayRef = tripRef.collection('days').doc(day.date)
    batch.set(dayRef, day)
    for (const activity of activities) {
      batch.set(dayRef.collection('activities').doc(), activity)
    }
    for (const restaurant of restaurants) {
      batch.set(dayRef.collection('restaurants').doc(), restaurant)
    }
  }
  await batch.commit()

  const driveDays = FIXTURE_DAYS.filter((d) => d.day.drive)
  const totalKm = driveDays.reduce(
    (sum, d) => sum + (d.day.drive?.distanceKm ?? 0),
    0,
  )
  const avgDriveMinutesPerDay =
    driveDays.reduce((sum, d) => sum + (d.day.drive?.durationMin ?? 0), 0) /
    driveDays.length

  await tripRef.update({
    'planMeta.status': 'ready',
    'planMeta.totalKm': totalKm,
    'planMeta.avgDriveMinutesPerDay': avgDriveMinutesPerDay,
    'planMeta.generatedAt': new Date().toISOString(),
  })
}

/** Creates a trip via the real app UI, then seeds the fixture plan directly. */
export async function createTripWithPlan(page: Page): Promise<string> {
  await page.goto('/')
  await page.getByTestId('trip-name-input').waitFor()
  const tripId = await page.evaluate(() => localStorage.getItem('tripId'))
  if (!tripId) throw new Error('tripId missing from localStorage')
  await seedFixturePlan(tripId)
  return tripId
}
