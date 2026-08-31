import { expect, test } from './fixtures.js'
import { getApps, initializeApp } from 'firebase-admin/app'
import { getFirestore } from 'firebase-admin/firestore'
import {
  createTripWithPlan,
  evaluateWithRetry,
  getDayIdByDate,
} from './helpers/seedFixturePlan.js'
import { signIn } from './helpers/signIn.js'

process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:8080'
const PROJECT_ID = 'demo-rv-trip-planner'
if (getApps().length === 0) initializeApp({ projectId: PROJECT_ID })
const adminDb = getFirestore()

async function getTripId(page: import('@playwright/test').Page): Promise<string> {
  await signIn(page)
  await page.getByTestId('trip-name-input').waitFor()
  const tripId = await evaluateWithRetry(page, () => localStorage.getItem('tripId'))
  if (!tripId) throw new Error('tripId missing from localStorage')
  return tripId
}

/**
 * The generation-time chips (`header-total-km`, `header-avg-drive-minutes`)
 * were removed on 2026-08-24 when the two number rows were combined. They
 * came from `planMeta`, written by the last full generation, while the
 * driving figures beside them are live from Directions — so the merged row
 * showed both and they disagreed ("3223 km … 2281 km"). The live ones are
 * the ones that are true; the day COUNT survives, because it says what the
 * budget does not: how many days the itinerary HAS.
 */
test('overview map header summarizes the plan (route/km/day count)', async ({
  page,
}) => {
  await createTripWithPlan(page)

  await page.getByTestId('nav-map').click()
  await page.getByTestId('day-strip').waitFor()

  await expect(page.getByTestId('header-day-count')).toHaveText('3 days')
  await expect(page.getByTestId('header-total-km')).toHaveCount(0)
  await expect(page.getByTestId('header-avg-drive-minutes')).toHaveCount(0)

  // Everything the traveler curates against, on one row.
  const totals = page.getByTestId('explore-route-totals')
  await expect(totals).toBeVisible()
  await expect(totals).toContainText('days')
})

// The day-badge tap itself (T-21) is wired via AdvancedMarker's onClick to
// `navigate(/map/day/:dayId)` in OverviewMapScreen.tsx, but this sandbox's
// network policy blocks the Google Maps JS API from loading in the
// Playwright browser (confirmed via the agent proxy's relay-failure log,
// not an app bug — see master_plan.md's T-20 note), so no marker ever
// mounts to click. This test instead verifies the navigation's destination
// — DayViewScreen — renders the right day directly, same as a real click
// would after the map library finishes loading in a real browser.
test('day view shows the right day when navigated to directly', async ({
  page,
}) => {
  const tripId = await createTripWithPlan(page)
  const dayId = await getDayIdByDate(tripId, '2026-07-10')
  await page.goto(`/map/day/${dayId}`)
  await page.getByTestId('day-view').waitFor()
  await expect(page.getByTestId('day-view-date')).toContainText('Day 1')
  await expect(page.getByTestId('day-view-date')).toContainText('2026-07-10')
})

test('request changes flow submits a replan with locked days preserved', async ({
  page,
}) => {
  await createTripWithPlan(page)
  await page.getByTestId('nav-map').click()
  await page.getByTestId('day-strip').waitFor()

  await page.getByTestId('request-changes-button').click()
  await page.getByTestId('change-request-text').fill('more beaches, skip big cities')

  const firstDayLock = page.getByTestId(/^lock-toggle-/).first()
  await firstDayLock.locator('input[type="checkbox"]').check()

  await page.getByTestId('submit-change-request').click()
  await expect(page.getByTestId('change-request-text')).toHaveCount(0)
})

test('map tab shows explore mode and no header stats before a plan exists', async ({
  page,
}) => {
  await getTripId(page)

  await page.getByTestId('nav-map').click()
  await page.getByTestId('explore-map-screen').waitFor()
  await expect(page.getByTestId('explore-find-stops-button')).toBeVisible()

  await expect(page.getByTestId('day-strip')).toHaveCount(0)
  await expect(page.getByTestId('request-changes-button')).toHaveCount(0)
})

test('map tab shows a generating banner with progress and no header stats', async ({
  page,
}) => {
  const tripId = await getTripId(page)
  await adminDb.collection('trips').doc(tripId).update({
    'planMeta.status': 'generating',
    'planMeta.progressCurrent': 2,
    'planMeta.progressTotal': 8,
  })

  await page.getByTestId('nav-map').click()
  await page.getByTestId('map-generating-banner').waitFor()

  await expect(page.getByTestId('map-generating-banner')).toContainText('2/8 days')
  await expect(page.getByTestId('day-strip')).toHaveCount(0)
})

test('map tab shows the plan error and no header stats when generation failed', async ({
  page,
}) => {
  const tripId = await getTripId(page)
  await adminDb.collection('trips').doc(tripId).update({
    'planMeta.status': 'error',
    'planMeta.error': 'Could not resolve the start point.',
  })

  await page.getByTestId('nav-map').click()
  await page.getByTestId('map-error-banner').waitFor()

  await expect(page.getByTestId('map-error-banner')).toContainText(
    'Could not resolve the start point.',
  )
  await expect(page.getByTestId('day-strip')).toHaveCount(0)
})

test('map tab flags a back-loaded trip, and lets the notice be dismissed', async ({
  page,
}) => {
  const tripId = await createTripWithPlan(page)
  // Dated ahead rather than hardcoded: pacing advice about a day already
  // driven expires (2026-08-31, "this list on top seems completely
  // obsolete!"), and the fixture's own July dates are long past. What this
  // test is about — a back-loaded trip being flagged and the notice staying
  // dismissed — is unchanged by which day it names.
  const nextWeek = new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10)
  await adminDb
    .collection('trips')
    .doc(tripId)
    .update({
      'planMeta.pacingWarnings': [
        `By the end of day 2 (${nextWeek}) this trip still has 320 km a day left to drive across its remaining 3 driving days — well above the 206 km a day it needs on average.`,
      ],
    })

  await page.getByTestId('nav-map').click()
  await page.getByTestId('pacing-warning-banner').waitFor()

  await expect(page.getByTestId('pacing-warning-banner')).toContainText(
    'km a day left to drive',
  )
  // Advice, not an error — the plan itself is still fully usable behind it.
  await expect(page.getByTestId('day-strip')).toBeVisible()

  await page.getByTestId('dismiss-pacing-warning').click()
  await expect(page.getByTestId('pacing-warning-banner')).toHaveCount(0)

  // Reported 2026-08-24: "Remove this top banner from being recurring as
  // well. It's ok on app launch, but not every time." PlanStrip unmounts on
  // every hop off the Map tab, so a dismissal held in component state bought
  // silence only until the next tap back.
  await page.getByTestId('nav-diary').click()
  await page.getByTestId('nav-map').click()
  await page.getByTestId('day-strip').waitFor()
  await expect(page.getByTestId('pacing-warning-banner')).toHaveCount(0)

  // A reload is the SAME session — sessionStorage survives it — so the
  // answer still holds. Asserted because "dismissed" surviving a refresh is
  // the behaviour, not an accident of it.
  await page.reload()
  await page.getByTestId('day-strip').waitFor()
  await expect(page.getByTestId('pacing-warning-banner')).toHaveCount(0)

  // A new tab is a new session with the same signed-in trip (auth and tripId
  // live in localStorage, the dismissal does not) — which is the "ok on app
  // launch" half of the report. The banner is entitled to one more say.
  const relaunched = await page.context().newPage()
  await relaunched.goto('/')
  await relaunched.getByTestId('nav-map').click()
  await relaunched.getByTestId('day-strip').waitFor()
  await expect(relaunched.getByTestId('pacing-warning-banner')).toBeVisible()
  await relaunched.close()
})
