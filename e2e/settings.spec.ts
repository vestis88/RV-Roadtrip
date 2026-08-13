import { getApps, initializeApp } from 'firebase-admin/app'
import { getFirestore } from 'firebase-admin/firestore'
import { expect, test } from './fixtures.js'
import { evaluateWithRetry } from './helpers/seedFixturePlan.js'
import { signIn } from './helpers/signIn.js'

process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:8080'
const PROJECT_ID = 'demo-rv-trip-planner'
if (getApps().length === 0) initializeApp({ projectId: PROJECT_ID })
const adminDb = getFirestore()

async function setRange(locator: import('@playwright/test').Locator, value: string) {
  await locator.evaluate((el: HTMLInputElement, v: string) => {
    const proto = Object.getPrototypeOf(el) as object
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set
    setter?.call(el, v)
    el.dispatchEvent(new Event('input', { bubbles: true }))
    el.dispatchEvent(new Event('change', { bubbles: true }))
  }, value)
}

// PlaceAutocompleteInput renders either a plain <input> (fallback, e.g. when
// the Places library hasn't loaded) or a real `gmp-place-autocomplete`
// custom element once Google's library is reachable — the latter isn't a
// native <input>/<textarea>, so .fill()/.blur()/toHaveValue don't apply to
// it. Set/read its `value` property directly and dispatch the same 'blur'
// event the component's own manual-entry handler listens for.
async function setPlaceInput(locator: import('@playwright/test').Locator, value: string) {
  await locator.evaluate((el: HTMLInputElement, v: string) => {
    el.focus()
    el.value = v
    el.blur()
  }, value)
}

async function getPlaceInputValue(locator: import('@playwright/test').Locator) {
  return locator.evaluate((el: HTMLInputElement) => el.value)
}

/**
 * Sets a start/finish point WITH real coordinates, the way picking a
 * Places suggestion does in the real app. Typing a name alone can't work
 * here: hasRoute now requires located points (a named point still sitting
 * on the (0,0) sentinel is exactly the Gulf-of-Guinea bug it guards
 * against), and the Maps API is unreachable in this sandbox, so a typed
 * name can never resolve.
 */
const SEEDED_TRIP_NAME = 'Routed trip'

async function seedRoute(tripId: string) {
  await adminDb
    .collection('trips')
    .doc(tripId)
    .update({
      'meta.name': SEEDED_TRIP_NAME,
      'settings.startPoint': { name: 'Oslo, Norway', lat: 59.91, lng: 10.75 },
      'settings.endPoint': { name: 'Bergen, Norway', lat: 60.39, lng: 5.32 },
    })
}

/**
 * Firestore's persistent cache serves the previous copy of the trip first
 * and the server's a moment later, so a reload right after seeding can
 * render a route-less trip briefly. Generating in that window is correctly
 * refused — so wait for the seeded name, which rides in on the very same
 * snapshot as the route.
 */
async function waitForSeededRoute(page: import('@playwright/test').Page) {
  await expect(page.getByTestId('trip-name-input')).toHaveValue(
    SEEDED_TRIP_NAME,
  )
}

test('settings form fills and persists across reload, without falsely marking an idle trip stale', async ({
  page,
}) => {
  await signIn(page)
  await page.getByTestId('trip-name-input').waitFor()
  await expect(page.getByTestId('plan-status')).toHaveText('idle')

  await page.getByTestId('start-date-input').fill('2026-07-10')
  await page.getByTestId('end-date-input').fill('2026-08-02')

  await setPlaceInput(page.getByTestId('start-point-input'), 'Oslo, Norway')
  await setPlaceInput(page.getByTestId('end-point-input'), 'Rome, Italy')

  await page.getByTestId('traveler-add').click()
  await page.getByTestId('traveler-name-0').fill('Bim')
  await page.getByTestId('traveler-add').click()
  await page.getByTestId('traveler-name-1').fill('Kid')
  await page.getByTestId('traveler-role-1').selectOption('child')
  await page.getByTestId('traveler-age-1').fill('8')

  await page.getByTestId('interest-chip-hiking').click()
  await page.getByTestId('interest-chip-beaches').click()
  await page.getByTestId('interest-free-entry').fill('waterfalls')
  await page.getByTestId('interest-free-entry-add').click()

  await page.getByTestId('country-chip-NO').click()
  await page.getByTestId('country-chip-IT').click()

  await setRange(page.getByTestId('rest-day-frequency-input'), '5')
  // Set before max-drive-hours so that one stays the last write this test
  // waits on below.
  await setRange(page.getByTestId('off-grid-tolerance-input'), '2')
  await setRange(page.getByTestId('max-drive-hours-input'), '6')

  // A trip that's never had a plan generated has nothing settings changes
  // could invalidate — status must stay 'idle', not jump to 'stale' as if
  // a real plan existed and just went out of date (see the shared
  // updateTripSettings.ts fix this test guards).
  await expect(page.getByTestId('plan-status')).toHaveText('idle')

  // Every field commits its own Firestore write independently; wait for the
  // last one (max-drive-hours) to actually reach the emulator before
  // reloading — nothing here flips a visible status to confirm that anymore.
  await page.waitForTimeout(500)

  await page.reload()
  await page.getByTestId('trip-name-input').waitFor()

  await expect(page.getByTestId('start-date-input')).toHaveValue('2026-07-10')
  await expect(page.getByTestId('end-date-input')).toHaveValue('2026-08-02')
  expect(await getPlaceInputValue(page.getByTestId('start-point-input'))).toBe(
    'Oslo, Norway',
  )
  expect(await getPlaceInputValue(page.getByTestId('end-point-input'))).toBe(
    'Rome, Italy',
  )
  await expect(page.getByTestId('traveler-name-0')).toHaveValue('Bim')
  await expect(page.getByTestId('traveler-name-1')).toHaveValue('Kid')
  await expect(page.getByTestId('traveler-role-1')).toHaveValue('child')
  await expect(page.getByTestId('traveler-age-1')).toHaveValue('8')
  await expect(page.getByTestId('interest-chip-hiking')).toHaveAttribute(
    'aria-pressed',
    'true',
  )
  await expect(page.getByTestId('interest-chip-beaches')).toHaveAttribute(
    'aria-pressed',
    'true',
  )
  await expect(page.getByTestId('interest-chip-waterfalls')).toHaveAttribute(
    'aria-pressed',
    'true',
  )
  await expect(page.getByTestId('country-chip-NO')).toHaveAttribute(
    'aria-pressed',
    'true',
  )
  await expect(page.getByTestId('country-chip-IT')).toHaveAttribute(
    'aria-pressed',
    'true',
  )
  await expect(page.getByTestId('rest-day-frequency-input')).toHaveValue('5')
  // Optional on tripSettingsSchema (pre-existing trips have none stored), so
  // this also covers that a stored value survives the round trip rather than
  // being re-defaulted on read.
  await expect(page.getByTestId('off-grid-tolerance-input')).toHaveValue('2')
  await expect(page.getByTestId('max-drive-hours-input')).toHaveValue('6')
  await expect(page.getByTestId('plan-status')).toHaveText('idle')
})

// Reported with a screenshot of a trip named "Luxemburg" whose country
// could not be named: the preferred-countries chips were a fixed list of
// sixteen, so anywhere else in the world was simply unselectable. The value
// stored is an ISO 3166-1 alpha-2 code (tripSettingsSchema rejects anything
// else, and a rejected write leaves a trip document that no longer parses),
// so the real check here is that a country added by search survives the
// round trip through Firestore exactly like a preset chip does.
test('a country with no chip can be found by search, and persists like a preset', async ({
  page,
}) => {
  await signIn(page)
  await page.getByTestId('trip-name-input').waitFor()

  await expect(page.getByTestId('country-chip-LU')).toHaveCount(0)

  await page.getByTestId('country-search').fill('luxem')
  await page.getByTestId('country-search-result-LU').click()

  // Named, not a bare "LU", and pressed like any other selected chip.
  const chip = page.getByTestId('country-chip-LU')
  await expect(chip).toHaveAttribute('aria-pressed', 'true')
  await expect(chip).toContainText('Luxembourg')
  // The presets stay exactly where they were — one tap away, not pushed
  // aside by the long tail.
  await expect(page.getByTestId('country-chip-NO')).toBeVisible()

  // Searching for it again offers no duplicate; it says it's already there
  // rather than claiming no such country exists.
  await page.getByTestId('country-search').fill('luxem')
  await expect(page.getByTestId('country-search-result-LU')).toHaveCount(0)
  await expect(page.getByTestId('country-search-empty')).toContainText(
    'Already in your list',
  )

  // Same commit() path as every other field — an independent Firestore
  // write with nothing visible flipping to confirm it landed.
  await page.waitForTimeout(500)
  await page.reload()
  await page.getByTestId('trip-name-input').waitFor()

  await expect(page.getByTestId('country-chip-LU')).toHaveAttribute(
    'aria-pressed',
    'true',
  )

  // And it deselects by tapping the chip, exactly like a preset.
  await page.getByTestId('country-chip-LU').click()
  await expect(page.getByTestId('country-chip-LU')).toHaveCount(0)
  await page.waitForTimeout(500)
  await page.reload()
  await page.getByTestId('trip-name-input').waitFor()
  await expect(page.getByTestId('country-chip-LU')).toHaveCount(0)
})

test('editing settings on a trip with a ready plan marks it stale', async ({
  page,
}) => {
  await signIn(page)
  await page.getByTestId('trip-name-input').waitFor()
  const tripId = await evaluateWithRetry(page, () => localStorage.getItem('tripId'))
  if (!tripId) throw new Error('tripId missing from localStorage')

  await adminDb
    .collection('trips')
    .doc(tripId)
    .update({ 'planMeta.status': 'ready' })
  await page.reload()
  await page.getByTestId('trip-name-input').waitFor()
  await expect(page.getByTestId('plan-status')).toHaveText('ready')

  await setRange(page.getByTestId('max-drive-hours-input'), '6')

  await expect(page.getByTestId('plan-status')).toHaveText('stale')
})

test('Trip Setup offers both "Generate overview" and "Generate full plan" for an idle trip', async ({
  page,
}) => {
  // The generate-overview assertion below waits on the functions emulator's
  // cold start, which can outrun the default 30s per-test budget on its own
  // — leaving the assertion's own 30s timeout unreachable.
  test.setTimeout(90_000)
  await signIn(page)
  await page.getByTestId('trip-name-input').waitFor()
  await expect(page.getByTestId('plan-status')).toHaveText('idle')

  await expect(page.getByTestId('generate-overview-button')).toHaveText(
    'Generate overview',
  )
  await expect(page.getByTestId('generate-plan-button')).toHaveText(
    'Generate full plan',
  )

  // A route is required before either button will spend a Claude call —
  // see the dedicated test below for that guard itself.
  const tripId = await evaluateWithRetry(page, () => localStorage.getItem('tripId'))
  if (!tripId) throw new Error('tripId missing from localStorage')
  await seedRoute(tripId)
  await page.reload()
  await waitForSeededRoute(page)

  // No CLAUDE_API_KEY in this sandbox — same credential-less degradation
  // explore.spec.ts's own "find great stops" test exercises, confirming
  // this button drives the same generateExploreHighlights callable rather
  // than silently doing nothing.
  await page.getByTestId('generate-overview-button').click()
  // Generous timeout: this is often the first callable the functions
  // emulator runs in a suite, and its cold start includes a Secret Manager
  // lookup that can only fail slowly here (no credentials in the sandbox).
  await expect(page.getByTestId('generate-overview-error')).toBeVisible({
    timeout: 30_000,
  })
  // A failed attempt must not navigate away.
  await expect(page.getByTestId('trip-name-input')).toBeVisible()
})

test('"Generate overview" and "Generate full plan" both require a start and finish point first', async ({
  page,
}) => {
  await signIn(page)
  await page.getByTestId('trip-name-input').waitFor()
  // A brand-new trip starts with both points blank — reported as
  // "Generate overview" silently returning 0 stops with no explanation,
  // since (0, 0) still looks like a real coordinate downstream.

  await page.getByTestId('generate-overview-button').click()
  await expect(page.getByTestId('route-required-error')).toContainText(
    'start and finish point',
  )
  // No network call was made at all — no credential-less error appears.
  await expect(page.getByTestId('generate-overview-error')).toHaveCount(0)

  await page.getByTestId('generate-plan-button').click()
  await expect(page.getByTestId('route-required-error')).toContainText(
    'start and finish point',
  )
  await expect(page.getByTestId('confirm-generate-dialog')).toHaveCount(0)

  // Naming just one point still isn't enough.
  const tripId = await evaluateWithRetry(page, () => localStorage.getItem('tripId'))
  if (!tripId) throw new Error('tripId missing from localStorage')
  await adminDb
    .collection('trips')
    .doc(tripId)
    .update({
      'settings.startPoint': { name: 'Oslo, Norway', lat: 59.91, lng: 10.75 },
    })
  await page.reload()
  await page.getByTestId('trip-name-input').waitFor()
  await page.getByTestId('generate-overview-button').click()
  await expect(page.getByTestId('route-required-error')).toBeVisible()

  // A point that has a NAME but no located coordinates is still refused —
  // that's the state a typed-but-unresolved place leaves behind.
  await adminDb
    .collection('trips')
    .doc(tripId)
    .update({ 'settings.endPoint': { name: 'Bergen, Norway', lat: 0, lng: 0 } })
  await page.reload()
  await page.getByTestId('trip-name-input').waitFor()
  await page.getByTestId('generate-plan-button').click()
  await expect(page.getByTestId('confirm-generate-dialog')).toHaveCount(0)
  await expect(page.getByTestId('route-required-error')).toBeVisible()

  // Only once it is genuinely located does the expensive path open up.
  await seedRoute(tripId)
  await page.reload()
  await waitForSeededRoute(page)
  await page.getByTestId('generate-plan-button').click()
  await expect(page.getByTestId('confirm-generate-dialog')).toBeVisible()
})

// Regression: "Switching from trip setup to map seems to disable the
// overview generation" — a generation still running server-side
// (planMeta.exploreStatus: 'generating') must keep showing as in-progress
// no matter which screen shows it, since the traveler can freely tab
// between Trip Setup and Map mid-generation. Previously each screen only
// tracked its own local "am I submitting" state, which reset to false on
// remount (e.g. navigating away and back) — making a real, still-running
// generation look like it had silently stopped.
test('a generation already running server-side shows as in-progress on both Trip Setup and Map, even on a fresh mount', async ({
  page,
}) => {
  await signIn(page)
  await page.getByTestId('trip-name-input').waitFor()
  const tripId = await evaluateWithRetry(page, () => localStorage.getItem('tripId'))
  if (!tripId) throw new Error('tripId missing from localStorage')

  // Simulates a generation kicked off elsewhere (or from a previous mount
  // of this same screen) that's still in flight — not something this test
  // itself triggers via a click.
  await adminDb
    .collection('trips')
    .doc(tripId)
    .update({ 'planMeta.exploreStatus': 'generating' })
  await page.reload()
  await page.getByTestId('trip-name-input').waitFor()

  await expect(page.getByTestId('generate-overview-button')).toHaveText(
    'Finding great stops…',
  )
  await expect(page.getByTestId('generate-overview-button')).toBeDisabled()

  await page.getByTestId('nav-map').click()
  await page.getByTestId('explore-map-screen').waitFor()
  await expect(page.getByTestId('explore-find-stops-button')).toHaveText(
    'Finding great stops…',
  )
  await expect(page.getByTestId('explore-find-stops-button')).toBeDisabled()

  await page.getByTestId('nav-setup').click()
  await page.getByTestId('trip-name-input').waitFor()
  await expect(page.getByTestId('generate-overview-button')).toHaveText(
    'Finding great stops…',
  )
})
