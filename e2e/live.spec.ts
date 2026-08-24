import { expect, test } from './fixtures.js'
import { getApps, initializeApp } from 'firebase-admin/app'
import { getFirestore } from 'firebase-admin/firestore'
import { signIn } from './helpers/signIn.js'
import { evaluateWithRetry } from './helpers/seedFixturePlan.js'

if (getApps().length === 0) initializeApp({ projectId: 'demo-rv-trip-planner' })
const adminDb = getFirestore()

/**
 * Phase 8 of the board rework, 2026-08-23: "I would like to have a live
 * function, which is basically find things around us now."
 *
 * Geolocation is stubbed, which is the one thing that makes this assertable
 * at all — unlike map pins, which need a live Google map and a key CI does
 * not have.
 */
test('live mode needs a position before it will search', async ({
  page,
  context,
}) => {
  await context.clearPermissions()
  await signIn(page)
  await page.getByTestId('trip-name-input').waitFor()

  await page.getByTestId('nav-live').click()
  await page.getByTestId('live-screen').waitFor()

  // Every preset is offered but none can run: "here" is not known yet.
  await expect(page.getByTestId('live-preset-lunch')).toBeDisabled()
  await expect(page.getByTestId('live-search-button')).toBeDisabled()
})

test('live mode offers the meal presets and free text once it knows where we are', async ({
  page,
  context,
}) => {
  await context.grantPermissions(['geolocation'])
  await context.setGeolocation({ latitude: 61.77, longitude: 9.54 })
  await signIn(page)
  await page.getByTestId('trip-name-input').waitFor()

  await page.getByTestId('nav-live').click()
  await page.getByTestId('live-screen').waitFor()

  // The same vocabulary the day-by-day plan uses, plus a way to say
  // something it does not cover.
  for (const preset of ['breakfast', 'lunch', 'dinner', 'activity', 'sleep']) {
    await expect(page.getByTestId(`live-preset-${preset}`)).toBeEnabled()
  }
  await expect(page.getByTestId('live-free-text')).toBeVisible()

  // Nothing has been written to the trip by opening the screen or by having
  // a position — the whole point of the mode is that it saves nothing until
  // asked.
  const tripId = await evaluateWithRetry(page, () => localStorage.getItem('tripId'))
  if (!tripId) throw new Error('tripId missing from localStorage')
  const stops = await adminDb
    .collection('trips')
    .doc(tripId)
    .collection('corridorStops')
    .get()
  expect(stops.size).toBe(0)
})

/**
 * PHASE 7'S POSITION MARKER IS NOT ASSERTED HERE, deliberately.
 *
 * The first version of this file did assert it, with a comment claiming the
 * marker "renders without a live Google map". That was wrong: it is an
 * `<AdvancedMarker>` child, so it hits exactly the constraint already
 * recorded for every other pin — markers only mount inside a live map, which
 * needs `VITE_GOOGLE_MAPS_API_KEY`, a CI secret. The test failed with 0
 * elements and was right to.
 *
 * So the marker is covered where it can be: `useCurrentPosition` is unit
 * tested against a stubbed geolocation API. Same split as MarkerBadge's pin
 * colours (unit) versus the legend (e2e).
 */
