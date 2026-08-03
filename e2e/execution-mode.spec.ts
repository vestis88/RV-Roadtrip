import { expect, test } from './fixtures.js'
import { getApps, initializeApp } from 'firebase-admin/app'
import { getFirestore } from 'firebase-admin/firestore'
import { evaluateWithRetry } from './helpers/seedFixturePlan.js'
import { signIn } from './helpers/signIn.js'

process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:8080'
const PROJECT_ID = 'demo-rv-trip-planner'
if (getApps().length === 0) initializeApp({ projectId: PROJECT_ID })
const adminDb = getFirestore()

const LILLEHAMMER = { name: 'Lillehammer Camping', lat: 61.1153, lng: 10.4662 }
const today = new Date().toISOString().slice(0, 10)

async function createTripAndSeedTodayDay(
  page: import('@playwright/test').Page,
) {
  await signIn(page)
  await page.getByTestId('trip-name-input').waitFor()
  const tripId = await evaluateWithRetry(page, () => localStorage.getItem('tripId'))
  if (!tripId) throw new Error('tripId missing from localStorage')

  await adminDb
    .collection('trips')
    .doc(tripId)
    .collection('days')
    .doc(today)
    .set({
      index: 0,
      date: today,
      type: 'rest',
      overnight: {
        name: LILLEHAMMER.name,
        lat: LILLEHAMMER.lat,
        lng: LILLEHAMMER.lng,
        country: 'NO',
      },
      summary: "Today's planned stop for the execution-mode test.",
    })

  return tripId
}

test('shows a replan prompt when >50km behind, and Snooze suppresses it for the rest of the day', async ({
  page,
  context,
}) => {
  await context.grantPermissions(['geolocation'])
  // Oslo is ~110km from Lillehammer — well past the 50km threshold.
  await context.setGeolocation({ latitude: 59.9139, longitude: 10.7522 })

  await createTripAndSeedTodayDay(page)

  await expect(page.getByTestId('replan-prompt')).toBeVisible({
    timeout: 10_000,
  })
  await expect(page.getByTestId('replan-prompt')).toContainText(
    'behind plan',
  )

  await page.getByTestId('replan-prompt-snooze').click()
  await expect(page.getByTestId('replan-prompt')).toHaveCount(0)

  // Snooze must survive a reload for the rest of the day.
  await page.reload()
  await page.getByTestId('trip-name-input').waitFor()
  await page.waitForTimeout(1500)
  await expect(page.getByTestId('replan-prompt')).toHaveCount(0)
})

test('clicking Re-plan submits a replan request carrying the measured behindScheduleKm', async ({
  page,
  context,
}) => {
  // Bug fix, reported 2026-07-27: the replan pipeline needs to know this
  // was triggered by falling behind schedule (not a voluntary "Request
  // changes" edit) so it can ask for an easy first day instead of pacing
  // it the same as the rest of the remainder — see replanTrip.ts.
  await context.grantPermissions(['geolocation'])
  await context.setGeolocation({ latitude: 59.9139, longitude: 10.7522 })

  const tripId = await createTripAndSeedTodayDay(page)

  await expect(page.getByTestId('replan-prompt')).toBeVisible({
    timeout: 10_000,
  })
  await page.getByTestId('replan-prompt-replan').click()
  await expect(page.getByTestId('replan-prompt')).toHaveCount(0)

  await expect
    .poll(
      async () => {
        const snap = await adminDb
          .collection('planRequests')
          .where('tripId', '==', tripId)
          .where('kind', '==', 'replan')
          .get()
        return snap.size
      },
      { timeout: 10_000 },
    )
    .toBe(1)

  const [requestDoc] = (
    await adminDb
      .collection('planRequests')
      .where('tripId', '==', tripId)
      .where('kind', '==', 'replan')
      .get()
  ).docs
  const behindScheduleKm = requestDoc.data().replanContext?.behindScheduleKm
  expect(typeof behindScheduleKm).toBe('number')
  expect(behindScheduleKm).toBeGreaterThan(50)
})

test('does not prompt when within 50km of the planned stop', async ({
  page,
  context,
}) => {
  await context.grantPermissions(['geolocation'])
  await context.setGeolocation({
    latitude: LILLEHAMMER.lat,
    longitude: LILLEHAMMER.lng,
  })

  await createTripAndSeedTodayDay(page)
  await page.waitForTimeout(1500)

  await expect(page.getByTestId('replan-prompt')).toHaveCount(0)
})

test('falls back to a manual position prompt when geolocation permission is denied', async ({
  page,
  context,
}) => {
  await context.clearPermissions()
  // Headless Chromium under automation leaves an unanswered geolocation
  // prompt in permission-state "prompt" forever — getCurrentPosition's own
  // `timeout` option only bounds acquisition *after* a permission decision,
  // so it never fires either. Stub the API directly to deterministically
  // exercise the app's PERMISSION_DENIED handling instead of depending on
  // this sandbox's flaky browser-permission plumbing.
  await page.addInitScript(() => {
    // @ts-expect-error - overriding a read-only browser API for the test
    navigator.geolocation.getCurrentPosition = (
      _success: PositionCallback,
      error?: PositionErrorCallback,
    ) => {
      error?.({
        code: 1,
        message: 'User denied Geolocation',
        PERMISSION_DENIED: 1,
        POSITION_UNAVAILABLE: 2,
        TIMEOUT: 3,
      } as GeolocationPositionError)
    }
  })

  await createTripAndSeedTodayDay(page)

  await expect(page.getByTestId('manual-position-prompt')).toBeVisible({
    timeout: 15_000,
  })

  // Oslo coordinates, ~110km from the planned stop.
  await page.getByTestId('manual-position-lat').fill('59.9139')
  await page.getByTestId('manual-position-lng').fill('10.7522')
  await page.getByTestId('manual-position-submit').click()

  await expect(page.getByTestId('replan-prompt')).toBeVisible()
})
