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

test('overview map header summarizes the plan (route/km/day count)', async ({
  page,
}) => {
  await createTripWithPlan(page)

  await page.getByTestId('nav-map').click()
  await page.getByTestId('map-header').waitFor()

  await expect(page.getByTestId('header-day-count')).toHaveText('3 days')
  await expect(page.getByTestId('header-total-km')).toBeVisible()
  await expect(page.getByTestId('header-avg-drive-minutes')).toBeVisible()
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
  await page.getByTestId('map-header').waitFor()

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

  await expect(page.getByTestId('map-header')).toHaveCount(0)
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
  await expect(page.getByTestId('map-header')).toHaveCount(0)
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
  await expect(page.getByTestId('map-header')).toHaveCount(0)
})
