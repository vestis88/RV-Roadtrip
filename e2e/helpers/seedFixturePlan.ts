import type { Page } from '@playwright/test'
import { getApps, initializeApp } from 'firebase-admin/app'
import { getFirestore } from 'firebase-admin/firestore'

/**
 * `page.evaluate()` binds to one execution context and throws "Execution
 * context was destroyed, most likely because of a navigation" if the page
 * reloads mid-call — unlike Playwright's locator actions (`waitFor`,
 * `click`, `fill`), which retry automatically across a navigation. A reload
 * can land in the gap between a `waitFor()` resolving and the very next
 * `evaluate()` — the service worker's `controllerchange` reload in
 * src/main.tsx used to fire on every first-ever page load (fixed — it now
 * only fires on a genuine cross-deploy update, not the initial claim of an
 * uncontrolled page), and general contention under a full-suite run can
 * still land a reload in that exact window regardless. Retrying the whole
 * `evaluate()` call absorbs a reload landing there instead of failing the
 * test outright.
 */
export async function evaluateWithRetry<T>(
  page: Page,
  fn: () => T,
  attempts = 5,
): Promise<T> {
  let lastError: unknown
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await page.evaluate(fn)
    } catch (error) {
      lastError = error
      await page.waitForTimeout(200)
    }
  }
  throw lastError
}

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

  // Mirrors functions/src/corridorStops.ts's buildCorridorStopWrites
  // (not importable here — e2e helpers are a separate TS project from
  // functions/src): one committed corridorStops doc per distinct overnight
  // location, so specs exercising phase-3/4 corridor features (reorder,
  // lock/unlock, rescan) have real data to work against, same as a trip
  // generated through the real pipeline would.
  const corridorGroups = new Map<string, string[]>()

  for (const { day, activities, restaurants } of FIXTURE_DAYS) {
    // Auto-generated, matching the real backend (day docs are no longer
    // date-keyed) — see getDayIdByDate below for how specs reach a specific
    // day.
    const dayRef = tripRef.collection('days').doc()
    batch.set(dayRef, day)
    for (const activity of activities) {
      batch.set(dayRef.collection('activities').doc(), activity)
    }
    for (const restaurant of restaurants) {
      batch.set(dayRef.collection('restaurants').doc(), restaurant)
    }

    const key = `${day.overnight.lat}|${day.overnight.lng}`
    const dayIds = corridorGroups.get(key) ?? []
    dayIds.push(dayRef.id)
    corridorGroups.set(key, dayIds)
  }

  for (const { day } of FIXTURE_DAYS) {
    const key = `${day.overnight.lat}|${day.overnight.lng}`
    const dayIds = corridorGroups.get(key)
    if (!dayIds) continue
    const stopRef = tripRef.collection('corridorStops').doc()
    batch.set(stopRef, {
      name: day.overnight.name,
      lat: day.overnight.lat,
      lng: day.overnight.lng,
      country: day.overnight.country,
      status: 'committed',
      linkedDayIds: dayIds,
    })
    // Only materialize each distinct stop once.
    corridorGroups.delete(key)
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
    // Real geography matching the fixture's own first/last stops (day 0's
    // drive.fromName is literally 'Oslo') — a real trip always has these
    // set, and features that compute a leg back to the trip's own start
    // (e.g. reconcileCorridor reordering a stop into the first position)
    // need a genuine point to measure from, not the {lat:0,lng:0} a bare
    // createTrip call defaults to.
    'settings.startPoint': { name: 'Oslo', lat: 59.9139, lng: 10.7522 },
    'settings.endPoint': { name: 'Otta', lat: 61.7725, lng: 9.5406 },
    // Phase 4b's reconciliation always recomputes the final date sequence as
    // settings.startDate + i (add/remove changes the day count, so it can no
    // longer just reuse the existing day dates verbatim the way a pure
    // reorder could) — a bare createTrip call defaults this to "today", which
    // wouldn't match FIXTURE_DAYS's own 2026-07-10..12 dates at all.
    'settings.startDate': '2026-07-10',
    'settings.endDate': '2026-07-12',
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
  const tripId = await evaluateWithRetry(page, () => localStorage.getItem('tripId'))
  if (!tripId) throw new Error('tripId missing from localStorage')
  await seedFixturePlan(tripId)
  return tripId
}

/**
 * Logs one diary entry against a day's first activity, the way marking a
 * card Done does. Specs that render the diary (rather than exercise the
 * marking flow itself) otherwise start from an empty log.
 */
export async function seedDiaryEntry(
  tripId: string,
  date: string,
  note: string,
): Promise<void> {
  const dayId = await getDayIdByDate(tripId, date)
  const activities = await adminDb
    .collection('trips')
    .doc(tripId)
    .collection('days')
    .doc(dayId)
    .collection('activities')
    .limit(1)
    .get()
  if (activities.empty) {
    throw new Error(`No activity to log against on ${date} of trip ${tripId}`)
  }
  await adminDb.collection('trips').doc(tripId).collection('log').add({
    date,
    refType: 'activity',
    refPath: activities.docs[0].ref.path,
    note,
    createdAt: new Date().toISOString(),
  })
}

/**
 * Day docs have stable, auto-generated Firestore IDs, not date-keyed ones —
 * there's no other way to reach a specific day directly (e.g.
 * `/map/day/<id>`) in this sandbox, since Google Maps JS is network-blocked
 * here and clicking a day badge (the only in-app way to navigate to Day
 * View) has never been testable in this suite.
 */
export async function getDayIdByDate(
  tripId: string,
  date: string,
): Promise<string> {
  const snap = await adminDb
    .collection('trips')
    .doc(tripId)
    .collection('days')
    .where('date', '==', date)
    .limit(1)
    .get()
  if (snap.empty) {
    throw new Error(`No day found for date ${date} on trip ${tripId}`)
  }
  return snap.docs[0].id
}
