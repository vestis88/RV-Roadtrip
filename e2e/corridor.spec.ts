import { expect, test } from './fixtures.js'
import { getApps, initializeApp } from 'firebase-admin/app'
import { getFirestore } from 'firebase-admin/firestore'
import { createTripWithPlan } from './helpers/seedFixturePlan.js'
import { signIn } from './helpers/signIn.js'
import { MAX_RESCAN_RADIUS_KM } from '../src/lib/rescanRadius'

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

  // Two taps: the first aims the search circle, the second runs it.
  await page.getByTestId('rescan-corridor-button').click()
  await page.getByTestId('rescan-corridor-button').click()
  await expect(page.getByTestId('rescan-corridor-error')).toBeVisible({
    timeout: 10_000,
  })
})

// The circle was drawn on every map all the time, which buried the pins under
// a boundary nobody had asked to see. It appears when the search is aimed and
// not before.
test('the search area is only shown while aiming a rescan', async ({ page }) => {
  await createTripWithPlan(page)
  await page.getByTestId('nav-map').click()
  await page.getByTestId('map-header').waitFor()

  await expect(page.getByTestId('rescan-corridor-scope')).toHaveCount(0)
  await expect(page.getByTestId('rescan-corridor-button')).toContainText(
    'Rescan this area',
  )

  await page.getByTestId('rescan-corridor-button').click()

  // Aiming: the button now names what it will search, and there is a way out.
  await expect(page.getByTestId('rescan-corridor-scope')).toBeVisible()
  await expect(page.getByTestId('rescan-corridor-button')).toContainText(
    'Search this circle',
  )

  await page.getByTestId('rescan-corridor-cancel').click()
  await expect(page.getByTestId('rescan-corridor-scope')).toHaveCount(0)
  await expect(page.getByTestId('rescan-corridor-button')).toContainText(
    'Rescan this area',
  )
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
  // Two taps — aim, then search.
  await page.getByTestId('rescan-corridor-button').click({ force: true })
  await page.getByTestId('rescan-corridor-button').click({ force: true })

  // No error banner — the scan it would be reporting on is still running.
  await expect(page.getByTestId('rescan-corridor-error')).toHaveCount(0)
  await expect(page.getByTestId('rescan-corridor-button')).toBeDisabled()
})

// The reason three rescan failures in a row were diagnosed by guesswork:
// the cause existed only in the rejected promise on the traveler's phone.
// A phone that had already stopped following the call — locked screen,
// switched tab, cellular NAT timeout, all routine — never saw it, so every
// failure looked identical from the outside and the fixes for them were
// guesses. The server now writes what went wrong onto the trip, where it
// outlives the connection that started the scan.
test('a failure the phone never saw is still reported afterwards', async ({
  page,
}) => {
  const tripId = await createTripWithPlan(page)

  await adminDb
    .collection('trips')
    .doc(tripId)
    .update({
      'planMeta.rescanStatus': 'idle',
      'planMeta.rescanLastError':
        'The search answer was cut off before it finished — it ran out of output length.',
      'planMeta.rescanLastFailedAt': new Date().toISOString(),
    })

  await page.getByTestId('nav-map').click()
  await page.getByTestId('map-header').waitFor()

  await expect(page.getByTestId('rescan-corridor-error')).toContainText(
    'ran out of output length',
  )
})

// ...and stops being reported the moment a scan works, so a fixed problem
// doesn't sit on screen forever.
test('a later successful scan retires the last failure', async ({ page }) => {
  const tripId = await createTripWithPlan(page)
  const failedAt = new Date(Date.now() - 60_000).toISOString()

  await adminDb
    .collection('trips')
    .doc(tripId)
    .update({
      'planMeta.rescanStatus': 'idle',
      'planMeta.rescanLastError': 'The search returned no answer at all.',
      'planMeta.rescanLastFailedAt': failedAt,
      'planMeta.rescanLastRunAt': new Date().toISOString(),
      'planMeta.rescanLastFoundCount': 2,
      'planMeta.rescanLastDroppedTooFar': 0,
    })

  await page.getByTestId('nav-map').click()
  await page.getByTestId('map-header').waitFor()

  await expect(page.getByTestId('rescan-corridor-status')).toContainText(
    'Found 2 new stops',
  )
  await expect(page.getByTestId('rescan-corridor-error')).toHaveCount(0)
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
      // The CAP, not a round number. Seeded as 50 until 2026-08-22, which is
      // what the cap was when this was written — and when the cap moved to
      // 150 this quietly stopped testing its own premise, because the advice
      // it asserts was given unconditionally and passed either way.
      'planMeta.rescanLastRadiusKm': MAX_RESCAN_RADIUS_KM,
    })

  await page.getByTestId('nav-map').click()
  await page.getByTestId('map-header').waitFor()

  const status = page.getByTestId('rescan-corridor-status')
  await expect(status).toContainText('4 places')
  // Names the circle it is talking about, and points INWARD — correct here
  // and only here: at the cap the circle has stopped growing with the view,
  // so zooming out only enlarges the part of the view that is not searched.
  await expect(status).toContainText(`${MAX_RESCAN_RADIUS_KM} km`)
  await expect(status).toContainText('zoom in')
  await expect(status).not.toContainText('zoom out')
  await expect(status).not.toContainText('Nothing new found')
})

/**
 * The same message below the cap, where the advice reverses.
 *
 * Reported 2026-08-22 from a map centred on Plansee: "Found 4 places, but
 * they were outside the 7 km searched — zoom in on them and scan again",
 * with four real attractions just beyond the circle. Zooming in shrinks the
 * circle, so following that instruction guarantees the same answer.
 */
test('a scan whose circle came from the viewport says to zoom OUT', async ({
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
      'planMeta.rescanLastRadiusKm': 25,
    })

  await page.getByTestId('nav-map').click()
  await page.getByTestId('map-header').waitFor()

  const status = page.getByTestId('rescan-corridor-status')
  await expect(status).toContainText('4 places')
  await expect(status).toContainText('25 km')
  await expect(status).toContainText('zoom out')
  await expect(status).not.toContainText('zoom in')
})

// The other way "Nothing new found nearby" was untrue: the search proposed
// real places and every one failed its map-data lookup. That is not an empty
// area, is not fixed by zooming out, and points at Places rather than at the
// search — so it must not be reported as the same thing.
test('a scan whose finds could not be located says that, not "nothing"', async ({
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
      'planMeta.rescanLastDroppedTooFar': 0,
      'planMeta.rescanLastNotLocated': 3,
    })

  await page.getByTestId('nav-map').click()
  await page.getByTestId('map-header').waitFor()

  const status = page.getByTestId('rescan-corridor-status')
  await expect(status).toContainText(
    'none of them could be found on the map',
  )
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

/**
 * Reported 2026-08-19: "I'm not happy with how the overview is gone after
 * the plan is done... as we moved into detailed planning, the previously
 * researched thing just look boring and can only be removed, so the whole
 * functionality is gone."
 *
 * It was accurate twice over. This screen had no candidate list at all, and
 * the card a pin opened gated "Lock in" on status `proposed` — which nothing
 * curated in explore mode ever is, so a curated stop's only offer was to
 * delete it.
 */
test('curated stops survive into the plan, with their curation intact', async ({
  page,
}) => {
  const tripId = await createTripWithPlan(page)
  const stops = adminDb.collection('trips').doc(tripId).collection('corridorStops')
  const added = await stops.add({
    name: 'Jotunheimen National Park',
    lat: 61.5,
    lng: 8.3,
    country: 'NO',
    why: 'Norway’s highest peaks, with marked day hikes from the road.',
    status: 'candidate',
    linkedDayIds: [],
    priority: 'worth-a-detour',
    region: 'Gudbrandsdalen',
    rank: 0,
    baseTown: 'Lom',
    interest: 'hiking',
    timeNeeded: 'full-day',
  })

  await page.getByTestId('nav-map').click()
  await page.getByTestId('map-header').waitFor()

  // The list is back, and the stop is in it. It is the BOARD's list now —
  // the plan stopped having a separate screen with a separate list on
  // 2026-08-23, so "survives into the plan" is a weaker claim than it was:
  // the list never goes away in the first place.
  const list = page.getByTestId('explore-candidate-list')
  await expect(list).toContainText('Jotunheimen National Park')

  // And the map is still there. The first version of this list starved the
  // map to zero height — `flex-1` is a basis of zero, so a tall sibling took
  // all of it — and these tests passed anyway because none of them looked at
  // the map. Reported as "now the map is gone".
  const canvas = await page.getByTestId('explore-map-canvas').boundingBox()
  expect(canvas?.height ?? 0).toBeGreaterThan(200)

  // Everything the explore card shows, still shown — the curation did not
  // stop existing when planning started.
  await expect(
    page.getByTestId(`explore-candidate-serves-${added.id}`),
  ).toContainText('hiking')
  await expect(
    page.getByTestId(`explore-candidate-time-${added.id}`),
  ).toContainText('A full day')
  await expect(list).toContainText('Sleep in Lom')
  await expect(list).toContainText('Norway’s highest peaks')

  // Selecting from the list is a real selection, not just a highlight — it
  // is what the camera follows. The pan itself needs a live Google map (and
  // so a Maps key CI does not have), so the rule behind it is unit-tested in
  // src/lib/mapSelection.test.ts; what this checks is that the list can
  // select at all, and that the selection shows.
  await page.getByTestId(`explore-candidate-${added.id}`).click()
  await expect(page.getByTestId(`explore-candidate-${added.id}`)).toHaveClass(
    /border-orange-600/,
  )

  // The interest level is still a decision, not a label.
  await page
    .getByTestId(`explore-candidate-interest-must-see-${added.id}`)
    .click()
  await expect
    .poll(async () => (await stops.doc(added.id).get()).data()?.priority)
    .toBe('must-see')

  // And "Lock in" is offered on a candidate — the gate that made this stop
  // removable and nothing else.
  await page.getByTestId(`explore-candidate-lock-${added.id}`).click()
  await expect
    .poll(async () => (await stops.doc(added.id).get()).data()?.status)
    .toBe('locked')

  // Once locked, the way into the itinerary is a button rather than a
  // sentence telling the traveler where to find one.
  await page.getByTestId(`explore-candidate-add-to-route-${added.id}`).click()
  await expect(page.getByTestId('reorder-corridor-panel')).toBeVisible()
})

// Turning a stop down has to be remembered, or the next "Find more stops"
// hands it straight back. Deletion was what the plan map offered instead.
test('a stop turned down in plan mode is remembered, not deleted', async ({
  page,
}) => {
  const tripId = await createTripWithPlan(page)
  const stops = adminDb.collection('trips').doc(tripId).collection('corridorStops')
  const added = await stops.add({
    name: 'Hunderfossen Eventyrpark',
    lat: 61.24,
    lng: 10.44,
    country: 'NO',
    why: 'A fairytale park.',
    status: 'candidate',
    linkedDayIds: [],
    priority: 'nice-if-convenient',
    rank: 0,
  })

  await page.getByTestId('nav-map').click()
  await page.getByTestId('map-header').waitFor()
  await page.getByTestId(`explore-candidate-reject-${added.id}`).click()

  await expect
    .poll(async () => (await stops.doc(added.id).get()).data()?.status)
    .toBe('rejected')
  // Still there as a tombstone, and gone from the list. The list itself
  // stays — it is the board's own, not a plan-mode extra that could vanish —
  // and says so rather than sitting there blank.
  await expect((await stops.doc(added.id).get()).exists).toBe(true)
  await expect(page.getByTestId('explore-candidate-list')).not.toContainText(
    'Jotunheimen National Park',
  )
  await expect(page.getByTestId('explore-empty-state')).toBeVisible()
})

/** A curated stop, so the screen actually has a list beside the map. */
async function seedConsideredStop(tripId: string) {
  await adminDb
    .collection('trips')
    .doc(tripId)
    .collection('corridorStops')
    .add({
      name: 'Jotunheimen National Park',
      lat: 61.5,
      lng: 8.3,
      country: 'NO',
      why: 'Norway’s highest peaks, with marked day hikes from the road.',
      status: 'candidate',
      linkedDayIds: [],
      priority: 'worth-a-detour',
      region: 'Gudbrandsdalen',
      rank: 0,
      baseTown: 'Lom',
      interest: 'hiking',
      timeNeeded: 'full-day',
    })
}

/**
 * Requested 2026-08-22: "there was previously a side by side map and list in
 * landscape mode on iPad. It's gone since the map size fix."
 *
 * It was not, in fact, ever on this screen — every version of it in history
 * stacks, and the split the traveler remembers is DayViewScreen's, which the
 * map-size fix never touched. The request is right regardless: an iPad in
 * landscape has room for both at full height, and stacking spends half the
 * screen on a list that then scrolls inside itself.
 *
 * Asserted geometrically rather than by class name, because the failure this
 * guards against is a layout that computes wrong, not a class that went
 * missing — the same reason the map's own floor is asserted by bounding box.
 * The 2026-08-19 regression shipped past a green suite for exactly the
 * opposite reason: nothing looked at the map at all.
 */
test('iPad landscape puts the map and the stops list side by side', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1180, height: 820 })
  const tripId = await createTripWithPlan(page)
  await seedConsideredStop(tripId)

  await page.getByTestId('nav-map').click()
  await page.getByTestId('map-header').waitFor()

  const map = page.getByTestId('explore-map-canvas')
  const list = page.getByTestId('explore-candidate-list')
  await map.waitFor()
  await list.waitFor()

  const mapBox = await map.boundingBox()
  const listBox = await list.boundingBox()
  if (!mapBox || !listBox) throw new Error('map or list not laid out')

  // Side by side: the list starts to the RIGHT of where the map ends...
  expect(listBox.x).toBeGreaterThanOrEqual(mapBox.x + mapBox.width - 1)
  // ...and they overlap vertically, rather than one sitting under the other.
  expect(listBox.y).toBeLessThan(mapBox.y + mapBox.height)
  // The map keeps real height — the thing that broke last time.
  expect(mapBox.height).toBeGreaterThan(400)
})

test('a portrait tablet still stacks them', async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 1366 })
  const tripId = await createTripWithPlan(page)
  await seedConsideredStop(tripId)

  await page.getByTestId('nav-map').click()
  await page.getByTestId('map-header').waitFor()

  // Both waited for BEFORE either is measured. Measuring the map first made
  // this fail at a height of 1248 rather than 1021: the corridorStops
  // snapshot had not arrived, so the map still had the screen to itself and
  // was measured mid-layout, against a list that only appeared afterwards.
  // A geometric assertion is only as good as the moment it is taken at.
  const map = page.getByTestId('explore-map-canvas')
  const list = page.getByTestId('explore-candidate-list')
  await map.waitFor()
  await list.waitFor()

  const mapBox = await map.boundingBox()
  const listBox = await list.boundingBox()
  if (!mapBox || !listBox) throw new Error('map or list not laid out')

  // 1024px wide clears the `lg` breakpoint, which is exactly why the
  // orientation check has to be there: this is a tall screen and belongs
  // stacked.
  expect(listBox.y).toBeGreaterThanOrEqual(mapBox.y + mapBox.height - 1)
  expect(mapBox.height).toBeGreaterThan(200)
})

/**
 * The point of the whole change, asserted directly.
 *
 * Reported 2026-08-23: "as soon as it goes to detailed plan, I feel like it's
 * too restricting and I actually lose the overview." The overview was not
 * lost to layout, and generation was not deleting it — the Map tab simply
 * rendered a different screen the moment `planMeta.status` stopped being
 * `idle`, and every curation action went with it.
 *
 * So: a trip WITH a plan must still offer the board. Asserted through the
 * actions, not through a testid, because "the board is present" means "I can
 * still curate", and a screen could carry the container without them.
 */
test('a planned trip still has the whole board, plus what the plan adds', async ({
  page,
}) => {
  const tripId = await createTripWithPlan(page)
  await seedConsideredStop(tripId)

  await page.getByTestId('nav-map').click()
  await page.getByTestId('explore-map-screen').waitFor()

  // The board's own controls, on a trip that has a finished plan.
  await expect(page.getByTestId('explore-find-stops-button')).toBeVisible()
  await expect(page.getByTestId('rescan-corridor-button')).toBeVisible()
  await expect(page.getByTestId('explore-candidate-list')).toContainText(
    'Jotunheimen National Park',
  )

  // And the plan's contribution, on the same screen rather than instead of it.
  await expect(page.getByTestId('map-header')).toBeVisible()
  await expect(page.getByTestId('header-day-count')).toBeVisible()
  await expect(page.getByTestId('request-changes-button')).toBeVisible()

  // A way into each day, which is what replaced the screen swap.
  const strip = page.getByTestId('day-strip')
  await expect(strip).toBeVisible()
  const firstDay = strip.getByRole('button').first()
  await firstDay.click()
  await expect(page).toHaveURL(/\/map\/day\//)
})

// The other half: a trip with no plan yet must not show plan chrome for a
// plan that does not exist.
test('a trip with no plan yet shows the board and no plan strip', async ({
  page,
}) => {
  await signIn(page)
  await page.getByTestId('trip-name-input').waitFor()

  await page.getByTestId('nav-map').click()
  await page.getByTestId('explore-map-screen').waitFor()

  await expect(page.getByTestId('explore-find-stops-button')).toBeVisible()
  await expect(page.getByTestId('map-header')).toHaveCount(0)
  await expect(page.getByTestId('day-strip')).toHaveCount(0)
})
