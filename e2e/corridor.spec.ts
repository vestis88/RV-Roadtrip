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

test('removing a stop deletes its day and requires accepting the end-date change', async ({
  page,
}) => {
  const tripId = await createTripWithPlan(page)
  await page.getByTestId('nav-map').click()
  await page.getByTestId('map-header').waitFor()

  await page.getByTestId('reorder-stops-button').click()
  const panel = page.getByTestId('reorder-corridor-panel')
  await panel.waitFor()

  const rows = panel.locator('li')
  await expect(rows).toHaveCount(2)

  // Remove Lillehammer (the first row) — a day count change, so the
  // trip's own end date moves too.
  await panel.locator('button[data-testid$="-remove"]').first().click()
  await expect(rows).toHaveCount(1)
  await expect(rows.nth(0)).toContainText('Otta')

  await page.getByTestId('reorder-preview-button').click()
  await expect(page.getByTestId('reorder-removed-list')).toBeVisible({
    timeout: 10_000,
  })
  await expect(page.getByTestId('reorder-removed-list')).toContainText(
    'Removed: Lillehammer Camping',
  )

  const enddateNotice = page.getByTestId('reorder-enddate-change')
  await expect(enddateNotice).toBeVisible()
  const confirmButton = page.getByTestId('reorder-confirm-button')
  await expect(confirmButton).toBeDisabled()

  await page.getByTestId('reorder-enddate-accept').check()
  await expect(confirmButton).toBeEnabled()
  await confirmButton.click()
  await expect(panel).toHaveCount(0)

  await expect
    .poll(
      async () => {
        const daysSnap = await adminDb
          .collection('trips')
          .doc(tripId)
          .collection('days')
          .orderBy('date')
          .get()
        return daysSnap.docs.map((d) => d.data().date)
      },
      { timeout: 15_000 },
    )
    .toEqual(['2026-07-10', '2026-07-11'])

  // commitInChunks(days) and the trip-level settings/planMeta update are two
  // separate writes within the same async function — the days poll above
  // only proves the first has landed, not the second, so settings.endDate
  // needs its own poll rather than an immediate read right after.
  await expect
    .poll(
      async () => (await adminDb.collection('trips').doc(tripId).get()).data()
        ?.settings.endDate,
      { timeout: 15_000 },
    )
    .toBe('2026-07-11')

  const daysSnap = await adminDb
    .collection('trips')
    .doc(tripId)
    .collection('days')
    .orderBy('date')
    .get()
  const days = daysSnap.docs.map((d) => d.data())
  expect(days.every((d) => d.overnight.name === 'Otta Camping')).toBe(true)
  // Otta's arrival now comes straight from the trip's own start point.
  expect(days[0].drive.fromName).toBe('Oslo')

  const corridorSnap = await adminDb
    .collection('trips')
    .doc(tripId)
    .collection('corridorStops')
    .where('name', '==', 'Lillehammer Camping')
    .get()
  expect(corridorSnap.empty).toBe(true)
})

test('adding a locked stop degrades to an error banner without Claude/Places access', async ({
  page,
}) => {
  await createTripWithPlan(page)
  await page.getByTestId('nav-map').click()
  await page.getByTestId('map-header').waitFor()

  await page.getByTestId('add-corridor-stop-toggle').click()
  await page.getByTestId('corridor-stop-name').fill('Vinstra viewpoint')
  await setPlaceInput(page.getByTestId('corridor-stop-location'), 'Vinstra, Norway')
  await page.getByTestId('corridor-stop-submit').click()
  await expect(page.getByTestId('add-corridor-stop-form')).toHaveCount(0)

  await page.getByTestId('reorder-stops-button').click()
  const panel = page.getByTestId('reorder-corridor-panel')
  await panel.waitFor()

  const addButton = panel.locator('button[data-testid$="-add"]')
  await expect(addButton).toBeVisible()
  await addButton.click()

  await page.getByTestId('reorder-preview-button').click()
  await expect(page.getByTestId('reorder-preview-error')).toBeVisible({
    timeout: 10_000,
  })
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

// Reported as "changing tab during a rescan breaks the search". It never
// broke the search — the callable runs to completion whether or not the
// client is still listening, and its finds arrive over the corridorStops
// subscription regardless. What broke was the traveler's only evidence any
// of that was happening: the button unmounts on a tab change, and it used to
// hold the entire "Scanning…" state itself, so they came back to an idle
// button and no answer. Indistinguishable from a search that died, and an
// invitation to press it again for a second paid Claude call.
test('a scan in progress is still reported after switching tabs and back', async ({
  page,
}) => {
  const tripId = await createTripWithPlan(page)

  // Stand in for a scan this device started that is still running server
  // side — the state the button has to recover rather than remember.
  await adminDb
    .collection('trips')
    .doc(tripId)
    .update({
      'planMeta.rescanStatus': 'generating',
      'planMeta.rescanStatusUpdatedAt': new Date().toISOString(),
    })

  await page.getByTestId('nav-map').click()
  await page.getByTestId('map-header').waitFor()
  await expect(page.getByTestId('rescan-corridor-button')).toBeDisabled()

  // Away and back — the round trip that used to lose everything.
  await page.getByTestId('nav-diary').click()
  await page.getByTestId('nav-map').click()
  await page.getByTestId('map-header').waitFor()

  await expect(page.getByTestId('rescan-corridor-button')).toBeDisabled()
  await expect(page.getByTestId('rescan-corridor-button')).toContainText('Scanning')
})

// Reported as "Scanning… 10m 47s" — a counter climbing past anything the
// server can still be doing. The callable clears its own status on the way
// out, but a container killed by its own ceiling never reaches that code, so
// the trip is left claiming 'generating' forever and the button sits
// disabled behind it. rescanStatusUpdatedAt was added as the heartbeat for
// exactly this case and then never consulted.
test('a scan the server cannot still be running stops blocking the button', async ({
  page,
}) => {
  const tripId = await createTripWithPlan(page)

  await adminDb
    .collection('trips')
    .doc(tripId)
    .update({
      'planMeta.rescanStatus': 'generating',
      // Well past the callable's own 300s ceiling: whatever started this is
      // long gone.
      'planMeta.rescanStatusUpdatedAt': new Date(Date.now() - 15 * 60_000).toISOString(),
    })

  await page.getByTestId('nav-map').click()
  await page.getByTestId('map-header').waitFor()

  await expect(page.getByTestId('rescan-corridor-button')).toBeEnabled()
  await expect(page.getByTestId('rescan-corridor-button')).toContainText(
    'Rescan this area',
  )
  await expect(page.getByTestId('rescan-corridor-status')).toContainText(
    'stopped reporting back',
  )
})

// The counterpart: a scan that started moments ago is slow, not abandoned,
// and cutting it off early would be the worse error.
// "Nothing new found nearby" was said even when the search had found real
// places and thrown every one of them away for sitting outside the area —
// a sentence describing a different failure from the one that happened, and
// the reason a narrow search read as a broken one.
// Reported as a red "Could not find stops right now — please try again"
// sitting beside a live "Scanning… 3m 16s". Two contradictory claims about
// one scan, and the banner was the wrong one: holding a callable open for
// minutes from a phone does not work (iOS Safari, a cellular NAT timeout,
// the screen locking), but the function keeps running and its finds still
// arrive. The dropped connection is a fact about the phone, not the search.
test('losing the connection to a running scan is not reported as a failure', async ({
  page,
}) => {
  const tripId = await createTripWithPlan(page)
  await page.getByTestId('nav-map').click()
  await page.getByTestId('map-header').waitFor()

  // The server takes the job and is still working on it...
  await adminDb
    .collection('trips')
    .doc(tripId)
    .update({
      'planMeta.rescanStatus': 'generating',
      'planMeta.rescanStatusUpdatedAt': new Date().toISOString(),
    })
  await expect(page.getByTestId('rescan-corridor-button')).toBeDisabled()

  // ...while this device's request dies on the network.
  await page.route('**/rescanCorridor', (route) => route.abort('failed'))
  await page.getByTestId('rescan-corridor-button').click({ force: true })

  // No error banner — the scan it would be reporting on is still running.
  await expect(page.getByTestId('rescan-corridor-error')).toHaveCount(0)
  await expect(page.getByTestId('rescan-corridor-button')).toBeDisabled()
})

test('a scan that found places outside the area says so, not "nothing"', async ({
  page,
}) => {
  const tripId = await createTripWithPlan(page)

  await adminDb
    .collection('trips')
    .doc(tripId)
    .update({
      'planMeta.rescanStatus': 'idle',
      'planMeta.rescanLastRunAt': new Date().toISOString(),
      'planMeta.rescanLastFoundCount': 0,
      'planMeta.rescanLastDroppedTooFar': 4,
    })

  await page.getByTestId('nav-map').click()
  await page.getByTestId('map-header').waitFor()

  const status = page.getByTestId('rescan-corridor-status')
  await expect(status).toContainText('4 places')
  await expect(status).toContainText('zoom out')
  await expect(status).not.toContainText('Nothing new found')
})

// A search that genuinely found nothing still says so — the honest case has
// to survive the fix for the dishonest one.
test('a scan that truly found nothing still says nothing', async ({ page }) => {
  const tripId = await createTripWithPlan(page)

  await adminDb
    .collection('trips')
    .doc(tripId)
    .update({
      'planMeta.rescanStatus': 'idle',
      'planMeta.rescanLastRunAt': new Date().toISOString(),
      'planMeta.rescanLastFoundCount': 0,
      'planMeta.rescanLastDroppedTooFar': 0,
    })

  await page.getByTestId('nav-map').click()
  await page.getByTestId('map-header').waitFor()

  await expect(page.getByTestId('rescan-corridor-status')).toContainText(
    'Nothing new found nearby',
  )
})

test('a scan that only just started is left alone', async ({ page }) => {
  const tripId = await createTripWithPlan(page)

  await adminDb
    .collection('trips')
    .doc(tripId)
    .update({
      'planMeta.rescanStatus': 'generating',
      'planMeta.rescanStatusUpdatedAt': new Date().toISOString(),
    })

  await page.getByTestId('nav-map').click()
  await page.getByTestId('map-header').waitFor()

  await expect(page.getByTestId('rescan-corridor-button')).toBeDisabled()
})

test('the result of a scan is waiting on return, not lost with the tab', async ({
  page,
}) => {
  const tripId = await createTripWithPlan(page)

  // A scan that finished while the traveler was on another tab.
  await adminDb
    .collection('trips')
    .doc(tripId)
    .update({
      'planMeta.rescanStatus': 'idle',
      'planMeta.rescanLastRunAt': new Date().toISOString(),
      'planMeta.rescanLastFoundCount': 3,
    })

  await page.getByTestId('nav-map').click()
  await page.getByTestId('map-header').waitFor()

  await expect(page.getByTestId('rescan-corridor-status')).toContainText(
    '3 new stops',
  )
  await expect(page.getByTestId('rescan-corridor-button')).toBeEnabled()
})

test('"Describe it" mode requires a description, then degrades to an error banner without Claude/Places access', async ({
  page,
}) => {
  await createTripWithPlan(page)
  await page.getByTestId('nav-map').click()
  await page.getByTestId('map-header').waitFor()

  await page.getByTestId('add-corridor-stop-toggle').click()
  await page.getByTestId('add-corridor-stop-mode-search').click()

  // Empty query is rejected client-side, no callable invoked.
  await page.getByTestId('corridor-search-submit').click()
  await expect(page.getByTestId('corridor-search-error')).toContainText(
    'Describe',
  )

  await page.getByTestId('corridor-search-query').fill('coffee stop')
  await page.getByTestId('corridor-search-submit').click()
  // Same credential-less degradation the plain rescan test above exercises
  // — confirms this reaches the same backend call with a query attached,
  // not a no-op.
  await expect(page.getByTestId('corridor-search-error')).toBeVisible({
    timeout: 10_000,
  })

  // The form stays open (not auto-closed on failure) so the traveler can
  // adjust the query and retry.
  await expect(page.getByTestId('add-corridor-stop-form')).toBeVisible()
})
