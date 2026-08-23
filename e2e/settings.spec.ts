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

/**
 * Retitled and re-pointed 2026-08-23. It used to move the DRIVE-HOURS slider
 * and assert staleness, which was true of every setting then and is true of
 * almost none of them now — see NON_INVALIDATING_SETTINGS. What survives is
 * the rule underneath: a setting that changes the ground the days were built
 * on still invalidates, and the trip's dates are the clearest such setting.
 */
test('editing a setting the days were built on marks the plan stale', async ({
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

  await page.getByTestId('end-date-input').fill('2026-07-28')

  await expect(page.getByTestId('plan-status')).toHaveText('stale')
})

// Added 2026-08-17: "I want the option to decide how many days ahead it
// should plan as a slider in trip setup."
test('the detail-window slider persists, and does not send a finished plan stale', async ({
  page,
}) => {
  await signIn(page)
  await page.getByTestId('trip-name-input').waitFor()
  const tripId = await evaluateWithRetry(page, () => localStorage.getItem('tripId'))
  if (!tripId) throw new Error('tripId missing from localStorage')

  // A trip that predates the setting shows the default rather than a blank
  // or a zero.
  await expect(page.getByTestId('detail-window-input')).toHaveValue('3')
  // Reported as "Asked to plan 2 days. Got all." — the hint has to lead with
  // the whole trip being routed, because that is the misreading.
  await expect(page.getByTestId('detail-window-hint')).toContainText(
    'Your whole trip is always routed',
  )

  await adminDb
    .collection('trips')
    .doc(tripId)
    .update({ 'planMeta.status': 'ready' })
  await page.reload()
  await page.getByTestId('trip-name-input').waitFor()
  await expect(page.getByTestId('plan-status')).toHaveText('ready')

  await setRange(page.getByTestId('detail-window-input'), '7')

  // The point of the exclusion: every other setting marks a ready plan
  // stale, and this one must not — the days it changes are filled in when
  // they are opened, so "Rebuild plan" would be asking the traveler to pay
  // for something they already have.
  await expect(page.getByTestId('detail-window-input')).toHaveValue('7')
  await expect(page.getByTestId('plan-status')).toHaveText('ready')

  await page.waitForTimeout(500)
  await page.reload()
  await page.getByTestId('trip-name-input').waitFor()
  await expect(page.getByTestId('detail-window-input')).toHaveValue('7')
  await expect(page.getByTestId('plan-status')).toHaveText('ready')
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

/**
 * Requested 2026-08-19: "how to just change dates of the trip then?" — and
 * the honest answer was that you could not, cheaply. A date edit marked the
 * plan stale and the only way out was a full rebuild, which deletes every day
 * and the traveler's per-day choices with it. Moving a trip without changing
 * its length changes nothing but every day's date.
 */
test('moving the trip a week later re-dates the plan instead of rebuilding it', async ({
  page,
}) => {
  await signIn(page)
  await page.getByTestId('trip-name-input').waitFor()
  const tripId = await evaluateWithRetry(page, () => localStorage.getItem('tripId'))
  if (!tripId) throw new Error('tripId missing from localStorage')

  const tripRef = adminDb.collection('trips').doc(tripId)
  const days = tripRef.collection('days')
  const dayA = days.doc()
  const dayB = days.doc()
  await dayA.set({
    index: 0,
    date: '2026-07-10',
    type: 'drive',
    overnight: { name: 'Otta', lat: 61.77, lng: 9.54, country: 'NO' },
    summary: 'First day.',
  })
  await dayB.set({
    index: 1,
    date: '2026-07-11',
    type: 'drive',
    overnight: { name: 'Lom', lat: 61.84, lng: 8.57, country: 'NO' },
    summary: 'Second day.',
  })
  await tripRef.update({
    'settings.startDate': '2026-07-10',
    'settings.endDate': '2026-07-11',
    'planMeta.status': 'ready',
  })
  await page.reload()
  await page.getByTestId('trip-name-input').waitFor()
  await expect(page.getByTestId('plan-status')).toHaveText('ready')

  // Move both ends a week out — the same trip, later.
  await page.getByTestId('start-date-input').fill('2026-07-17')
  await page.getByTestId('end-date-input').fill('2026-07-18')
  await expect(page.getByTestId('plan-status')).toHaveText('stale')

  // The cheap option is offered, and says which way it moves things.
  const shift = page.getByTestId('shift-dates-button')
  await expect(shift).toHaveText('Move the plan 7 days later')
  await shift.click()

  // Every day re-dated, plan usable again, and no regeneration ran.
  await expect
    .poll(async () => (await dayA.get()).data()?.date)
    .toBe('2026-07-17')
  await expect
    .poll(async () => (await dayB.get()).data()?.date)
    .toBe('2026-07-18')
  await expect(page.getByTestId('plan-status')).toHaveText('ready')
  await expect(page.getByTestId('shift-dates-button')).toHaveCount(0)
  // The summaries are the giveaway: a rebuild would have replaced them.
  expect((await dayA.get()).data()?.summary).toBe('First day.')
})

// Adding or removing days is a real planning problem — where the extra night
// goes, what gets cut — and re-dating cannot answer it.
test('changing the trip’s length offers no shortcut', async ({ page }) => {
  await signIn(page)
  await page.getByTestId('trip-name-input').waitFor()
  const tripId = await evaluateWithRetry(page, () => localStorage.getItem('tripId'))
  if (!tripId) throw new Error('tripId missing from localStorage')

  const tripRef = adminDb.collection('trips').doc(tripId)
  await tripRef.collection('days').doc().set({
    index: 0,
    date: '2026-07-10',
    type: 'drive',
    overnight: { name: 'Otta', lat: 61.77, lng: 9.54, country: 'NO' },
    summary: 'First day.',
  })
  await tripRef.update({
    'settings.startDate': '2026-07-10',
    'settings.endDate': '2026-07-10',
    'planMeta.status': 'ready',
  })
  await page.reload()
  await page.getByTestId('trip-name-input').waitFor()
  // Wait for the seeded status to reach the client: updateTripSettings only
  // marks a plan stale when it can see it was ready, so editing a date before
  // the snapshot arrives is a no-op and the assertion below would be testing
  // the race, not the rule.
  await expect(page.getByTestId('plan-status')).toHaveText('ready')

  // Same start, later finish — the trip got longer.
  await page.getByTestId('end-date-input').fill('2026-07-14')
  await expect(page.getByTestId('plan-status')).toHaveText('stale')
  await expect(page.getByTestId('shift-dates-button')).toHaveCount(0)
  await expect(page.getByTestId('generate-plan-button')).toHaveText(
    'Rebuild plan',
  )
})

/**
 * Phase 2 of the board rework, 2026-08-23: "I don't like that it goes 'stale'
 * and needs full generation. It should just grow organically."
 *
 * `stale` was never a broken plan — it has exactly two effects, this button's
 * label and the date-shift gate, and nothing blocks on it. So the question
 * per setting is whether it makes the days ALREADY WRITTEN wrong. A pacing
 * preference does not; it changes what the plan should be measured against,
 * and pacing is advice now.
 */
test('changing the drive-hours limit no longer offers to rebuild the plan', async ({
  page,
}) => {
  await signIn(page)
  await page.getByTestId('trip-name-input').waitFor()
  const tripId = await evaluateWithRetry(page, () => localStorage.getItem('tripId'))
  if (!tripId) throw new Error('tripId missing from localStorage')

  await adminDb.collection('trips').doc(tripId).update({
    'planMeta.status': 'ready',
  })
  await page.reload()
  await page.getByTestId('trip-name-input').waitFor()
  await expect(page.getByTestId('plan-status')).toHaveText('ready')

  await setRange(page.getByTestId('max-drive-hours-input'), '6')

  // The setting is saved…
  await expect
    .poll(async () =>
      (await adminDb.collection('trips').doc(tripId).get()).data()?.settings
        ?.maxDriveHoursPerDay,
    )
    .toBe(6)
  // …and the plan is still usable, with no rebuild put in front of anyone.
  await expect(page.getByTestId('plan-status')).toHaveText('ready')
})
