import { expect, test } from './fixtures.js'
import { getApps, initializeApp } from 'firebase-admin/app'
import { getFirestore } from 'firebase-admin/firestore'
import { signIn } from './helpers/signIn.js'
import { evaluateWithRetry } from './helpers/seedFixturePlan.js'

if (getApps().length === 0) initializeApp({ projectId: 'demo-rv-trip-planner' })
const adminDb = getFirestore()

/**
 * "What's near us" moved onto the map on 2026-08-24: "The find nearby
 * doesn't need to be triggered from a separate tab. Use the map view, so
 * it's easy to see the location of the results."
 *
 * Geolocation is stubbed, which is what makes the anchor assertable at all
 * — unlike the find pins themselves, which need a live Google map and a key
 * CI does not have.
 */
async function openSearchPanel(page: import('@playwright/test').Page) {
  await page.getByTestId('nav-map').click()
  await page.getByTestId('explore-map-screen').waitFor()
  await page.getByTestId('open-map-search').click()
  await page.getByTestId('map-search-panel').waitFor()
}

test('the nearby search lives on the map, not on its own tab', async ({
  page,
}) => {
  await signIn(page)
  await page.getByTestId('trip-name-input').waitFor()

  // The tab is gone; the search is where the map is.
  await expect(page.getByTestId('nav-live')).toHaveCount(0)
  await openSearchPanel(page)
  await expect(page.getByTestId('live-preset-lunch')).toBeVisible()
})

test('searching around us needs a position; searching the map does not', async ({
  page,
  context,
}) => {
  await context.clearPermissions()
  await signIn(page)
  await page.getByTestId('trip-name-input').waitFor()
  await openSearchPanel(page)

  // No fix yet, so there is no "here" to search around — and a silently
  // wrong anchor is worse than a disabled control.
  await expect(page.getByTestId('search-anchor-position')).toBeDisabled()
  // The map centre is always known, so the presets still work.
  await expect(page.getByTestId('live-preset-lunch')).toBeEnabled()
})

test('the anchor can be switched to our own position', async ({
  page,
  context,
}) => {
  await context.grantPermissions(['geolocation'])
  await context.setGeolocation({ latitude: 61.77, longitude: 9.54 })
  await signIn(page)
  await page.getByTestId('trip-name-input').waitFor()
  await openSearchPanel(page)

  const here = page.getByTestId('search-anchor-position')
  await expect(here).toBeEnabled({ timeout: 10_000 })
  await here.click()
  await expect(here).toHaveAttribute('aria-checked', 'true')
  await expect(page.getByTestId('search-anchor-map')).toHaveAttribute(
    'aria-checked',
    'false',
  )
})

/**
 * The reported bug: "currently the results are a bit too far away, so it
 * needs to be given the option to specify radius of search as well." The
 * viewport stays the default — that behaviour was confirmed right — and this
 * is an override beside it.
 */
test('a radius can be named instead of pinched', async ({ page }) => {
  await signIn(page)
  await page.getByTestId('trip-name-input').waitFor()
  await openSearchPanel(page)

  const radius = page.getByTestId('search-radius')
  await expect(radius).toHaveValue('viewport')
  await radius.selectOption('5')
  await expect(radius).toHaveValue('5')

  // The rescan button searches the circle the panel now names.
  await page.getByTestId('rescan-corridor-button').click()
  await expect(page.getByTestId('rescan-corridor-button')).toContainText('5 km')
})

test('a nearby search writes nothing until a find is added', async ({
  page,
}) => {
  await signIn(page)
  await page.getByTestId('trip-name-input').waitFor()
  const tripId = await evaluateWithRetry(page, () =>
    localStorage.getItem('tripId'),
  )
  if (!tripId) throw new Error('tripId missing from localStorage')

  await openSearchPanel(page)
  await page.getByTestId('live-preset-lunch').click()

  // No CLAUDE_API_KEY in this sandbox — the same credential-less
  // degradation every Claude-touching spec here exercises. What matters is
  // the invariant either way: nothing reached the corridor.
  await expect(
    page.getByTestId('live-error').or(page.getByTestId('live-finds')),
  ).toBeVisible({ timeout: 20_000 })

  const stops = await adminDb
    .collection('trips')
    .doc(tripId)
    .collection('corridorStops')
    .get()
  expect(stops.size).toBe(0)
})
