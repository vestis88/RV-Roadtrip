import { getApps, initializeApp } from 'firebase-admin/app'
import { getFirestore } from 'firebase-admin/firestore'
import { expect, test } from './fixtures.js'
import {
  createTripWithPlan,
  getDayIdByDate,
} from './helpers/seedFixturePlan.js'

process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:8080'
const PROJECT_ID = 'demo-rv-trip-planner'
if (getApps().length === 0) initializeApp({ projectId: PROJECT_ID })
const adminDb = getFirestore()

// PlaceAutocompleteInput renders a plain fallback <input> when the Places
// library hasn't loaded (e.g. no network route to Google's API in this
// sandbox) — same pattern settings.spec.ts already relies on.
async function setPlaceInput(locator: import('@playwright/test').Locator, value: string) {
  await locator.evaluate((el: HTMLInputElement, v: string) => {
    el.focus()
    el.value = v
    el.blur()
  }, value)
}

test('skipping an activity removes it from the row behind a "show skipped" toggle, reversibly', async ({
  page,
}) => {
  const tripId = await createTripWithPlan(page)
  const dayId = await getDayIdByDate(tripId, '2026-07-10')
  await page.goto(`/map/day/${dayId}`)
  await page.getByTestId('day-view').waitFor()

  await expect(page.getByTestId('activity-card-0-status')).toContainText(
    'suggested',
  )
  await page.getByTestId('activity-card-0-mark-skipped').click()

  // Gone from the main row — this is what clears room for whatever else was
  // generated for this slot, rather than a skipped card just sitting there.
  await expect(page.getByTestId('activity-card-0')).toHaveCount(0)
  const showSkipped = page.getByTestId('activities-row-show-skipped')
  await expect(showSkipped).toHaveText('Show 1 skipped')

  // But not lost outright — expanding the toggle brings it back, and it can
  // still be un-skipped from there.
  await showSkipped.click()
  await expect(page.getByTestId('activity-card-0-status')).toContainText(
    'skipped',
  )
  await page.getByTestId('activity-card-0-mark-selected').click()
  await expect(page.getByTestId('activity-card-0-status')).toContainText(
    'selected',
  )
  await expect(page.getByTestId('activities-row-show-skipped')).toHaveCount(0)
})

test('adding a custom activity writes a new selected activity card', async ({
  page,
}) => {
  const tripId = await createTripWithPlan(page)
  const dayId = await getDayIdByDate(tripId, '2026-07-10')
  await page.goto(`/map/day/${dayId}`)
  await page.getByTestId('day-view').waitFor()

  await page.getByTestId('add-custom-stop-toggle').click()
  await page.getByTestId('custom-stop-kind-activity').click()
  await page.getByTestId('custom-stop-name').fill('Sjoa river rafting')
  await setPlaceInput(page.getByTestId('custom-stop-location'), 'Sjoa, Norway')
  await page.getByTestId('custom-stop-category').selectOption('other')
  await page.getByTestId('custom-stop-kid-friendly').check()
  await page
    .getByTestId('custom-stop-blurb')
    .fill('A splash of adventure on a rest day.')
  await page.getByTestId('custom-stop-submit').click()

  await expect(page.getByTestId('add-custom-stop-form')).toHaveCount(0)
  await expect(page.getByTestId('activities-row')).toContainText(
    'Sjoa river rafting',
  )
})

test('adding a custom restaurant writes a new selected restaurant card in the right meal row', async ({
  page,
}) => {
  const tripId = await createTripWithPlan(page)
  const dayId = await getDayIdByDate(tripId, '2026-07-10')
  await page.goto(`/map/day/${dayId}`)
  await page.getByTestId('day-view').waitFor()

  await page.getByTestId('add-custom-stop-toggle').click()
  await page.getByTestId('custom-stop-kind-restaurant').click()
  await page.getByTestId('custom-stop-name').fill('Otta Café')
  await setPlaceInput(page.getByTestId('custom-stop-location'), 'Otta, Norway')
  await page.getByTestId('custom-stop-meal').selectOption('lunch')
  await page
    .getByTestId('custom-stop-blurb')
    .fill('Simple local café, good stop before the trail.')
  await page.getByTestId('custom-stop-submit').click()

  await expect(page.getByTestId('add-custom-stop-form')).toHaveCount(0)
  await expect(page.getByTestId('lunch-row')).toContainText('Otta Café')
  await expect(page.getByTestId('breakfast-row')).not.toContainText(
    'Otta Café',
  )
})

test('add-custom-stop form requires a name and description', async ({
  page,
}) => {
  const tripId = await createTripWithPlan(page)
  const dayId = await getDayIdByDate(tripId, '2026-07-10')
  await page.goto(`/map/day/${dayId}`)
  await page.getByTestId('day-view').waitFor()

  await page.getByTestId('add-custom-stop-toggle').click()
  await page.getByTestId('custom-stop-submit').click()
  await expect(page.getByTestId('custom-stop-error')).toBeVisible()
  await expect(page.getByTestId('add-custom-stop-form')).toBeVisible()
})

test('selecting an activity gives it a distinct look from tapping it', async ({
  page,
}) => {
  const tripId = await createTripWithPlan(page)
  const dayId = await getDayIdByDate(tripId, '2026-07-10')
  await page.goto(`/map/day/${dayId}`)
  await page.getByTestId('day-view').waitFor()

  const card = page.getByTestId('activity-card-0')
  await expect(card).not.toHaveClass(/border-sky-600/)
  await expect(card).not.toHaveClass(/border-orange-600/)

  const toggleButton = page.getByTestId('activity-card-0-mark-selected')
  await expect(toggleButton).toHaveText('Select')
  await toggleButton.click()
  await expect(card).toHaveClass(/border-sky-600/)
  await expect(page.getByTestId('activity-card-0-status')).toContainText(
    'selected',
  )

  // Tap-to-view is a separate, distinct highlight (orange) from the
  // data-level "selected" state (blue) — selecting alone must not trigger it.
  await expect(card).not.toHaveClass(/border-orange-600/)
  await card.click()
  await expect(card).toHaveClass(/border-orange-600/)
})

test('the same button unselects a selected activity, back to suggested', async ({
  page,
}) => {
  const tripId = await createTripWithPlan(page)
  const dayId = await getDayIdByDate(tripId, '2026-07-10')
  await page.goto(`/map/day/${dayId}`)
  await page.getByTestId('day-view').waitFor()

  const toggleButton = page.getByTestId('activity-card-0-mark-selected')
  const card = page.getByTestId('activity-card-0')

  await toggleButton.click()
  await expect(toggleButton).toHaveText('Unselect')
  await expect(page.getByTestId('activity-card-0-status')).toContainText(
    'selected',
  )

  await toggleButton.click()
  await expect(toggleButton).toHaveText('Select')
  await expect(page.getByTestId('activity-card-0-status')).toContainText(
    'suggested',
  )
  await expect(card).not.toHaveClass(/border-sky-600/)
})

test('request changes for this day submits a replan locking every other day', async ({
  page,
}) => {
  const tripId = await createTripWithPlan(page)
  const dayId = await getDayIdByDate(tripId, '2026-07-11')
  await page.goto(`/map/day/${dayId}`)
  await page.getByTestId('day-view').waitFor()

  await page.getByTestId('request-changes-for-day-button').click()
  await expect(page.getByTestId('request-changes-for-day-form')).toContainText(
    'Day 2',
  )
  await page
    .getByTestId('change-request-text-for-day')
    .fill('less driving today')
  await page.getByTestId('submit-change-request-for-day').click()

  await expect(page.getByTestId('request-changes-for-day-form')).toHaveCount(0)
})

test('opening "Change overnight stop" degrades to "nothing found" without Claude/Places/Overpass access', async ({
  page,
}) => {
  // CLAUDE_API_KEY/GOOGLE_PLACES_API_KEY aren't configured and Overpass is
  // off (network-blocked in the development sandbox; OVERPASS_DISABLED=1 on
  // CI, which has real internet and would otherwise return genuine Norwegian
  // stellplatz here — see the flag's note in overpassApi.ts). Same caveat as
  // T-14/T-16/T-18/T-22/countries.spec.ts's refresh test —
  // getOvernightCandidates has no
  // synthetic fallback by design. Each of its 3 sources now fails
  // independently (see overnightCandidatesCallable.ts's safe() helper) rather
  // than one unreachable source taking the whole call down, so with every
  // source unavailable the honest result is an empty list — the same
  // "genuinely found nothing" state a traveler would see with real
  // credentials if nothing were nearby, not an opaque error.
  const tripId = await createTripWithPlan(page)
  const dayId = await getDayIdByDate(tripId, '2026-07-10')
  await page.goto(`/map/day/${dayId}`)
  await page.getByTestId('day-view').waitFor()

  await page.getByTestId('change-overnight-toggle').click()
  await expect(page.getByTestId('overnight-candidates-panel')).toBeVisible()
  await expect(page.getByTestId('overnight-candidates-empty')).toBeVisible({
    timeout: 10_000,
  })

  await page.getByTestId('change-overnight-cancel').click()
  await expect(page.getByTestId('overnight-candidates-panel')).toHaveCount(0)
})

test('skipping the day\'s only activity, with a reserve one waiting, promotes it instantly', async ({
  page,
}) => {
  const tripId = await createTripWithPlan(page)
  const dayId = await getDayIdByDate(tripId, '2026-07-10')

  // The shared fixture only ever seeds one displayed activity per day, no
  // reserve — dismiss-and-requeue's own generation-time reserve pool
  // (placesApi.ts) needs its own seed here to exercise the "promote a
  // reserve item" path rather than the credential-less "research more"
  // fallback the other skip test already covers.
  await adminDb
    .collection('trips')
    .doc(tripId)
    .collection('days')
    .doc(dayId)
    .collection('activities')
    .add({
      name: 'Reserve hike',
      category: 'hike',
      lat: 61.11,
      lng: 10.47,
      blurb: 'Waiting in reserve.',
      kidFriendly: true,
      status: 'suggested',
      reserve: true,
    })

  await page.goto(`/map/day/${dayId}`)
  await page.getByTestId('day-view').waitFor()

  // Invisible until promoted.
  await expect(page.getByTestId('activities-row')).not.toContainText(
    'Reserve hike',
  )

  await page.getByTestId('activity-card-0-mark-skipped').click()

  await expect(page.getByTestId('activities-row')).toContainText(
    'Reserve hike',
    { timeout: 10_000 },
  )
  // No "researching"/"exhausted" notice — the reserve promotion was instant,
  // no researchMoreAlternatives call was needed.
  await expect(page.getByTestId('activities-row-requeue-notice')).toHaveCount(0)
})

test('skipping one of several activities still promotes a reserve immediately, even though others remain suggested', async ({
  page,
}) => {
  // Regression test: reported as "clicking skip does not bring up a fresh
  // alternative" — skipAndRequeue used to only refill once a scope's whole
  // live-suggested pool hit zero, so skipping one of several still-suggested
  // activities did nothing visible. Skip now means "not interested, show me
  // something else" every time, independent of how many other suggested
  // items are left in the row.
  const tripId = await createTripWithPlan(page)
  const dayId = await getDayIdByDate(tripId, '2026-07-10')

  await adminDb
    .collection('trips')
    .doc(tripId)
    .collection('days')
    .doc(dayId)
    .collection('activities')
    .add({
      name: 'Second suggestion',
      category: 'sight',
      lat: 61.12,
      lng: 10.48,
      blurb: 'Still on offer.',
      kidFriendly: true,
      status: 'suggested',
    })
  await adminDb
    .collection('trips')
    .doc(tripId)
    .collection('days')
    .doc(dayId)
    .collection('activities')
    .add({
      name: 'Reserve hike',
      category: 'hike',
      lat: 61.11,
      lng: 10.47,
      blurb: 'Waiting in reserve.',
      kidFriendly: true,
      status: 'suggested',
      reserve: true,
    })

  await page.goto(`/map/day/${dayId}`)
  await page.getByTestId('day-view').waitFor()
  // Firestore doesn't preserve write order, so which of the two starting
  // activities lands at card-0 isn't predictable — assert by count instead
  // of by name.
  const visibleCards = page.getByTestId(/^activity-card-\d+$/)
  await expect(visibleCards).toHaveCount(2)
  await expect(page.getByTestId('activities-row')).not.toContainText(
    'Reserve hike',
  )

  await page.getByTestId('activity-card-0-mark-skipped').click()

  await expect(page.getByTestId('activities-row')).toContainText(
    'Reserve hike',
    { timeout: 10_000 },
  )
  // The reserve promotion replaced the skipped card 1-for-1 — still 2
  // suggested cards visible, not 1, even though the pool wasn't drained.
  await expect(visibleCards).toHaveCount(2)
  await expect(page.getByTestId('activities-row-show-skipped')).toHaveText(
    'Show 1 skipped',
  )
  await expect(page.getByTestId('activities-row-requeue-notice')).toHaveCount(0)
})

test('skipping the day\'s only activity with no reserve left degrades to a "no more options" notice without Places access', async ({
  page,
}) => {
  // GOOGLE_PLACES_API_KEY isn't configured in this sandbox — researchMoreAlternatives
  // has no synthetic fallback by design, same caveat as every other
  // Places-touching callable in this suite. The fixture's day has exactly
  // one activity and no reserve, so skipping it exhausts both tiers at once.
  const tripId = await createTripWithPlan(page)
  const dayId = await getDayIdByDate(tripId, '2026-07-10')
  await page.goto(`/map/day/${dayId}`)
  await page.getByTestId('day-view').waitFor()

  await page.getByTestId('activity-card-0-mark-skipped').click()

  await expect(page.getByTestId('activities-row-requeue-notice')).toBeVisible({
    timeout: 10_000,
  })
})

test('selecting the day\'s only activity, with a reserve one waiting, promotes it instantly', async ({
  page,
}) => {
  // Mirrors the skip-triggered reserve test above, but via Select — there's
  // no "only one selected" rule anywhere in this app, so selecting the last
  // remaining suggested item drains the live pool exactly like skipping it
  // would, and must trigger the same promotion (see refillIfExhausted's own
  // doc comment in src/lib/placeStatus.ts).
  const tripId = await createTripWithPlan(page)
  const dayId = await getDayIdByDate(tripId, '2026-07-10')

  await adminDb
    .collection('trips')
    .doc(tripId)
    .collection('days')
    .doc(dayId)
    .collection('activities')
    .add({
      name: 'Reserve hike',
      category: 'hike',
      lat: 61.11,
      lng: 10.47,
      blurb: 'Waiting in reserve.',
      kidFriendly: true,
      status: 'suggested',
      reserve: true,
    })

  await page.goto(`/map/day/${dayId}`)
  await page.getByTestId('day-view').waitFor()

  await expect(page.getByTestId('activities-row')).not.toContainText(
    'Reserve hike',
  )

  await page.getByTestId('activity-card-0-mark-selected').click()

  await expect(page.getByTestId('activities-row')).toContainText(
    'Reserve hike',
    { timeout: 10_000 },
  )
  await expect(page.getByTestId('activities-row-requeue-notice')).toHaveCount(0)
})

test('selecting the day\'s only activity with no reserve left degrades to a "no more options" notice without Places access', async ({
  page,
}) => {
  const tripId = await createTripWithPlan(page)
  const dayId = await getDayIdByDate(tripId, '2026-07-10')
  await page.goto(`/map/day/${dayId}`)
  await page.getByTestId('day-view').waitFor()

  await page.getByTestId('activity-card-0-mark-selected').click()

  await expect(page.getByTestId('activities-row-requeue-notice')).toBeVisible({
    timeout: 10_000,
  })
})

/**
 * Reported 2026-09-02: *"I went in to add alternative overnight stops through
 * change overnight stops. It was not saved now that I went back to the same
 * day. I want the stops saved!!"*
 *
 * It was never saved. Picking submitted a scoped REPLAN and waited for a
 * Claude pass to rewrite the rest of the trip — a relic of the frozen-plan
 * model — so nothing changed on the day until that finished, and with the
 * API account out of credit it never finished at all.
 */
test('a chosen overnight is saved on the day, and survives coming back to it', async ({
  page,
}) => {
  const tripId = await createTripWithPlan(page)
  const dayId = await getDayIdByDate(tripId, '2026-07-10')
  const dayRef = adminDb.collection('trips').doc(tripId).collection('days').doc(dayId)

  // Options resolved earlier — the sandbox has no credentials to resolve
  // them live, and that is not what this is about.
  await dayRef.collection('overnightOptions').doc('c0').set({
    name: 'Camping Bella Italia',
    type: 'campsite',
    lat: 45.44,
    lng: 10.71,
    country: 'IT',
    description: 'Lakeside pitches with a pool.',
    source: 'places',
  })

  await page.goto(`/map/day/${dayId}`)
  await page.getByTestId('day-view').waitFor()

  await page.getByTestId('change-overnight-toggle').click()
  await page.getByTestId('overnight-candidate-pick-campsite-0').click()
  await expect(page.getByTestId('overnight-candidates-panel')).toHaveCount(0)

  // On the day itself, immediately — no plan request, nothing to wait for.
  await expect
    .poll(async () => (await dayRef.get()).data()?.overnight?.name, {
      timeout: 15_000,
    })
    .toBe('Camping Bella Italia')

  // The town the day belongs to is recorded, so the day list writer still
  // recognises it and cannot delete it out from under the choice.
  const saved = (await dayRef.get()).data()
  expect(saved?.townAnchor).toBeTruthy()

  // And it is still there on the way back, which is the whole report.
  await page.goto('/map')
  await page.getByTestId('day-strip').waitFor()
  await page.goto(`/map/day/${dayId}`)
  await expect(page.getByTestId('day-view')).toBeVisible()
  await expect(page.getByText('Camping Bella Italia').first()).toBeVisible({
    timeout: 15_000,
  })
})
