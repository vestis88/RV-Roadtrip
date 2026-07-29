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

test('reordering committed stops previews and commits a date/drive-leg swap', async ({
  page,
}) => {
  const tripId = await createTripWithPlan(page)
  await page.getByTestId('nav-map').click()
  await page.getByTestId('map-header').waitFor()

  await page.getByTestId('reorder-stops-button').click()
  const panel = page.getByTestId('reorder-corridor-panel')
  await panel.waitFor()

  // Fixture plan: 2026-07-10 Lillehammer (drive), 2026-07-11 Otta (drive),
  // 2026-07-12 Otta (rest) — 2 distinct committed stops (Lillehammer, Otta),
  // Otta's own drive+rest days grouped into one stop.
  const rows = panel.locator('li')
  await expect(rows).toHaveCount(2)
  await expect(rows.nth(0)).toContainText('Lillehammer')
  await expect(rows.nth(1)).toContainText('Otta')

  // Move Otta to first position.
  await panel.locator('button[data-testid$="-up"]').nth(1).click()
  await expect(rows.nth(0)).toContainText('Otta')
  await expect(rows.nth(1)).toContainText('Lillehammer')

  await page.getByTestId('reorder-preview-button').click()
  await expect(page.getByTestId('reorder-diff-list')).toBeVisible({
    timeout: 10_000,
  })

  await page.getByTestId('reorder-confirm-button').click()
  await expect(panel).toHaveCount(0)

  // The confirm just fires a planRequests doc — the generatePlan trigger
  // that actually applies the reorder runs asynchronously, same as
  // insertRestDay/replan, so the day docs don't reflect it immediately.
  await expect
    .poll(
      async () => {
        const daysSnap = await adminDb
          .collection('trips')
          .doc(tripId)
          .collection('days')
          .orderBy('date')
          .get()
        return daysSnap.docs.map((d) => d.data().overnight.name)
      },
      { timeout: 15_000 },
    )
    .toEqual(['Otta Camping', 'Otta Camping', 'Lillehammer Camping'])

  const daysSnap = await adminDb
    .collection('trips')
    .doc(tripId)
    .collection('days')
    .orderBy('date')
    .get()
  const days = daysSnap.docs.map((d) => d.data())
  expect(days.map((d) => d.type)).toEqual(['drive', 'rest', 'drive'])
  // Lillehammer now arrives from Otta instead of from the trip start.
  expect(days[2].drive.fromName).toBe('Otta Camping')
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
