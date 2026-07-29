import { expect, test } from './fixtures.js'
import { getApps, initializeApp } from 'firebase-admin/app'
import { getFirestore } from 'firebase-admin/firestore'
import { createTripWithPlan } from './helpers/seedFixturePlan.js'

process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:8080'
const PROJECT_ID = 'demo-rv-trip-planner'
if (getApps().length === 0) initializeApp({ projectId: PROJECT_ID })
const adminDb = getFirestore()

// PlaceAutocompleteInput renders a plain fallback <input> when the Places
// library hasn't loaded (e.g. no network route to Google's API in this
// sandbox) — same pattern manual-editing.spec.ts already relies on.
async function setPlaceInput(locator: import('@playwright/test').Locator, value: string) {
  await locator.evaluate((el: HTMLInputElement, v: string) => {
    el.focus()
    el.value = v
    el.blur()
  }, value)
}

test('adding a corridor stop writes a locked, unlinked corridorStops doc', async ({
  page,
}) => {
  const tripId = await createTripWithPlan(page)
  await page.getByTestId('nav-map').click()
  await page.getByTestId('map-header').waitFor()

  await page.getByTestId('add-corridor-stop-toggle').click()
  await page.getByTestId('corridor-stop-name').fill('Rondane viewpoint')
  await setPlaceInput(page.getByTestId('corridor-stop-location'), 'Rondane, Norway')
  await page.getByTestId('corridor-stop-why').fill('Sweeping mountain views.')
  await page.getByTestId('corridor-stop-submit').click()

  await expect(page.getByTestId('add-corridor-stop-form')).toHaveCount(0)

  const snap = await adminDb
    .collection('trips')
    .doc(tripId)
    .collection('corridorStops')
    .where('name', '==', 'Rondane viewpoint')
    .limit(1)
    .get()
  expect(snap.empty).toBe(false)
  const stop = snap.docs[0].data()
  expect(stop.status).toBe('locked')
  expect(stop.linkedDayIds).toEqual([])
  expect(stop.why).toBe('Sweeping mountain views.')
})

test('add-corridor-stop form requires a name', async ({ page }) => {
  await createTripWithPlan(page)
  await page.getByTestId('nav-map').click()
  await page.getByTestId('map-header').waitFor()

  await page.getByTestId('add-corridor-stop-toggle').click()
  await page.getByTestId('corridor-stop-submit').click()
  await expect(page.getByTestId('corridor-stop-form-error')).toBeVisible()
  await expect(page.getByTestId('add-corridor-stop-form')).toBeVisible()
})

test('rescanning this area degrades to an error banner without Claude/Places access', async ({
  page,
}) => {
  // CLAUDE_API_KEY/GOOGLE_PLACES_API_KEY aren't configured in this
  // credential-less emulator — generateRescanCandidates has no synthetic
  // fallback by design (same caveat as manual-editing.spec.ts's overnight
  // candidates test), so the callable throws and the button surfaces that
  // as an error rather than silently doing nothing.
  await createTripWithPlan(page)
  await page.getByTestId('nav-map').click()
  await page.getByTestId('map-header').waitFor()

  await page.getByTestId('rescan-corridor-button').click()
  await expect(page.getByTestId('rescan-corridor-error')).toBeVisible({
    timeout: 10_000,
  })
})
