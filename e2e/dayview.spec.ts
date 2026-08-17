import { expect, test } from './fixtures.js'
import { getApps, initializeApp } from 'firebase-admin/app'
import { getFirestore } from 'firebase-admin/firestore'
import {
  createTripWithPlan,
  getDayIdByDate,
} from './helpers/seedFixturePlan.js'

process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:8080'
const PROJECT_ID = 'demo-rv-trip-planner'
if (getApps().length === 0) initializeApp({ projectId: PROJECT_ID })
const adminDb = getFirestore()

async function waitFor<T>(
  fn: () => Promise<T | undefined>,
  timeoutMs = 20_000,
): Promise<T> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const result = await fn()
    if (result !== undefined) return result
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  throw new Error('Timed out waiting for condition')
}

const VIEWPORTS = {
  phone: { width: 375, height: 812 },
  ipadPortrait: { width: 820, height: 1180 },
  ipadLandscape: { width: 1180, height: 820 },
}

for (const [name, viewport] of Object.entries(VIEWPORTS)) {
  test(`day view layout renders drive card and activity/meal rows at ${name}`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport)
    const tripId = await createTripWithPlan(page)
    const dayId = await getDayIdByDate(tripId, '2026-07-10')
    await page.goto(`/map/day/${dayId}`)
    await page.getByTestId('day-view').waitFor()

    await expect(page.getByTestId('day-view-date')).toContainText('Day 1')
    await expect(page.getByTestId('drive-card')).toContainText('Oslo')
    await expect(page.getByTestId('activities-row')).toBeVisible()
    await expect(page.getByTestId('breakfast-row')).toBeVisible()
    await expect(page.getByTestId('lunch-row')).toBeVisible()
    await expect(page.getByTestId('dinner-row')).toBeVisible()
    await expect(page.getByTestId('activity-card-0')).toContainText(
      'Maihaugen',
    )
  })
}

test('rest day shows the no-driving banner instead of a drive card', async ({
  page,
}) => {
  const tripId = await createTripWithPlan(page)
  const dayId = await getDayIdByDate(tripId, '2026-07-12')
  await page.goto(`/map/day/${dayId}`)
  await page.getByTestId('day-view').waitFor()
  await expect(page.getByTestId('rest-day-banner')).toContainText(
    'No driving today',
  )
  await expect(page.getByTestId('drive-card')).toHaveCount(0)
})

test('prev/next arrows cycle days without visiting the overview', async ({
  page,
}) => {
  const tripId = await createTripWithPlan(page)
  const dayId10 = await getDayIdByDate(tripId, '2026-07-10')
  const dayId11 = await getDayIdByDate(tripId, '2026-07-11')
  const dayId12 = await getDayIdByDate(tripId, '2026-07-12')
  await page.goto(`/map/day/${dayId10}`)
  await page.getByTestId('day-view').waitFor()
  await expect(page.getByTestId('prev-day')).toBeDisabled()

  await page.getByTestId('next-day').click()
  await expect(page.getByTestId('day-view-date')).toContainText('2026-07-11')
  expect(page.url()).toContain(`/map/day/${dayId11}`)

  await page.getByTestId('next-day').click()
  await expect(page.getByTestId('day-view-date')).toContainText('2026-07-12')
  expect(page.url()).toContain(`/map/day/${dayId12}`)
  await expect(page.getByTestId('next-day')).toBeDisabled()
})

test('changing day resets the map from a focused pin back to an overview', async ({
  page,
}) => {
  const tripId = await createTripWithPlan(page)
  const dayId = await getDayIdByDate(tripId, '2026-07-10')
  await page.goto(`/map/day/${dayId}`)
  await page.getByTestId('day-view').waitFor()

  // Tapping a card focuses the map on it — the caption is the visible proof.
  await page.getByTestId('activity-card-0').click()
  await expect(page.getByTestId('map-selected-caption')).toContainText(
    'Maihaugen',
  )

  // Reported bug: navigating to a new day left that focused pin/caption on
  // screen instead of resetting to an overview of the new day's own pins.
  await page.getByTestId('next-day').click()
  await expect(page.getByTestId('day-view-date')).toContainText('2026-07-11')
  await expect(page.getByTestId('map-selected-caption')).toHaveCount(0)
})

test('swiping over the day view does not change day — that gesture is reserved for panning the map', async ({
  page,
}) => {
  const tripId = await createTripWithPlan(page)
  const dayId = await getDayIdByDate(tripId, '2026-07-10')
  await page.goto(`/map/day/${dayId}`)
  await page.getByTestId('day-view').waitFor()

  const dayView = page.getByTestId('day-view')
  const box = await dayView.boundingBox()
  if (!box) throw new Error('day-view has no bounding box')
  const midY = box.y + box.height / 2
  await dayView.dispatchEvent('touchstart', {
    touches: [{ identifier: 0, clientX: box.x + box.width - 20, clientY: midY }],
  })
  await dayView.dispatchEvent('touchend', {
    changedTouches: [{ identifier: 0, clientX: box.x + 20, clientY: midY }],
  })
  await expect(page.getByTestId('day-view-date')).toContainText('2026-07-10')
  expect(page.url()).toContain(`/map/day/${dayId}`)
})

// Regression for the incident that turned a three-day trip into eleven days.
// Both structural actions on this screen wrote a planRequest and then showed
// nothing at all — Day View never rendered planMeta.status, unlike Overview
// and Settings. runInsertRestDay is mechanical and sub-second, so the trip
// was 'ready' again almost immediately and the button was live: tapping it
// again, which is what anyone does when a button seems dead, inserted
// another day. generatePlan's claim lock never objected, because nothing
// ever overlapped — it guards concurrency, and this was repetition.
test('a submitted rest day is acknowledged, and blocks a second submission', async ({
  page,
}) => {
  const tripId = await createTripWithPlan(page)
  const dayId = await getDayIdByDate(tripId, '2026-07-10')
  await page.goto(`/map/day/${dayId}`)
  await page.getByTestId('day-view').waitFor()

  await page.getByTestId('add-rest-day-button').click()
  await page.getByTestId('add-rest-day-confirm').click()

  // The acknowledgement the screen never had. Raised before the form closes,
  // so there is no frame in which the tap appears to have done nothing.
  await expect(page.getByTestId('plan-busy-banner')).toBeVisible()

  // And the way back in is shut while that is true — the second tap simply
  // cannot happen.
  await expect(page.getByTestId('add-rest-day-button')).toBeDisabled()
  await expect(page.getByTestId('request-changes-for-day-button')).toBeDisabled()

  // Exactly one day added, and the controls come back once it lands.
  await expect
    .poll(
      async () =>
        (
          await adminDb.collection('trips').doc(tripId).collection('days').get()
        ).size,
      { timeout: 20_000 },
    )
    .toBe(4)
  await expect(page.getByTestId('add-rest-day-button')).toBeEnabled({
    timeout: 20_000,
  })
})

// "Add a rest day" is the one plan operation that runs entirely in the
// backend without Claude/Places/Routes, so — unlike the other planRequest
// flows — it completes for real in this credential-less emulator and can be
// asserted end to end.
test('adding a rest day inserts a day and pushes every later day back one', async ({
  page,
}) => {
  const tripId = await createTripWithPlan(page)
  const dayId = await getDayIdByDate(tripId, '2026-07-10')
  await page.goto(`/map/day/${dayId}`)
  await page.getByTestId('day-view').waitFor()

  await page.getByTestId('add-rest-day-button').click()
  await expect(page.getByTestId('add-rest-day-form')).toContainText(
    'Lillehammer Camping',
  )
  await page.getByTestId('add-rest-day-confirm').click()
  await expect(page.getByTestId('add-rest-day-form')).toHaveCount(0)

  const dayDates = await waitFor(async () => {
    const snap = await adminDb
      .collection('trips')
      .doc(tripId)
      .collection('days')
      .orderBy('date')
      .get()
    return snap.size === 4 ? snap.docs.map((d) => d.data().date) : undefined
  })

  // The fixture plan is 2026-07-10..12; the extra day lands on the 11th and
  // the two days that followed slide to the 12th and 13th.
  expect(dayDates).toEqual([
    '2026-07-10',
    '2026-07-11',
    '2026-07-12',
    '2026-07-13',
  ])

  const insertedSnap = await adminDb
    .collection('trips')
    .doc(tripId)
    .collection('days')
    .where('date', '==', '2026-07-11')
    .limit(1)
    .get()
  expect(insertedSnap.docs[0].data().type).toBe('rest')
  expect(insertedSnap.docs[0].data().overnight.name).toBe(
    'Lillehammer Camping',
  )

  // The day that used to be the 11th kept its content, one date later.
  const shiftedSnap = await adminDb
    .collection('trips')
    .doc(tripId)
    .collection('days')
    .where('date', '==', '2026-07-12')
    .limit(1)
    .get()
  expect(shiftedSnap.docs[0].data().summary).toContain('Gudbrandsdalen')
  expect(shiftedSnap.docs[0].data().index).toBe(2)

  await page.goto(`/map/day/${insertedSnap.docs[0].id}`)
  await expect(page.getByTestId('rest-day-banner')).toBeVisible()
})

test('selecting an activity reveals a time-of-day picker that writes the chosen slot', async ({
  page,
}) => {
  const tripId = await createTripWithPlan(page)
  const dayId = await getDayIdByDate(tripId, '2026-07-10')
  await page.goto(`/map/day/${dayId}`)
  await page.getByTestId('day-view').waitFor()

  // No picker until the activity is actually selected — picking a time of
  // day is meaningless before that (see PlaceCard's own comment).
  await expect(page.getByTestId('activity-card-0-time-of-day')).toHaveCount(0)

  await page.getByTestId('activity-card-0-mark-selected').click()
  await expect(page.getByTestId('activity-card-0-time-of-day')).toBeVisible()
  // Defaults to all-day until the traveler picks something more specific.
  await expect(
    page.getByTestId('activity-card-0-time-of-day-all-day'),
  ).toHaveAttribute('aria-pressed', 'true')

  await page.getByTestId('activity-card-0-time-of-day-evening').click()
  await expect(
    page.getByTestId('activity-card-0-time-of-day-evening'),
  ).toHaveAttribute('aria-pressed', 'true')
  await expect(
    page.getByTestId('activity-card-0-time-of-day-all-day'),
  ).toHaveAttribute('aria-pressed', 'false')

  const activityId = await waitFor(async () => {
    const snap = await adminDb
      .collection('trips')
      .doc(tripId)
      .collection('days')
      .doc(dayId)
      .collection('activities')
      .where('timeOfDay', '==', 'evening')
      .limit(1)
      .get()
    return snap.docs[0]?.id
  })
  expect(activityId).toBeTruthy()
})

// "Route eagerly, detail lazily" (2026-08-16): generation works out the
// route for the whole trip and the activities/restaurants for only the first
// few days. Everything past that window carries its route and is filled in
// when it is opened.
test('a day past the eager window says it is being worked out, and asks for itself', async ({
  page,
}) => {
  const tripId = await createTripWithPlan(page)
  const dayId = await getDayIdByDate(tripId, '2026-07-11')
  await adminDb
    .collection('trips')
    .doc(tripId)
    .collection('days')
    .doc(dayId)
    .update({ detailStatus: 'pending' })

  await page.goto(`/map/day/${dayId}`)
  await page.getByTestId('day-view').waitFor()

  await expect(page.getByTestId('day-detail-gate')).toBeVisible()

  // CLAUDE_API_KEY isn't configured in this credential-less emulator, so the
  // request it just fired fails — and the point is that the failure lands on
  // the day, where it outlives the connection that asked for it, rather than
  // leaving a spinner and no explanation.
  await expect(page.getByTestId('day-detail-error')).toBeVisible({
    timeout: 30_000,
  })
  const day = await adminDb
    .collection('trips')
    .doc(tripId)
    .collection('days')
    .doc(dayId)
    .get()
  // Back to pending, not stuck 'generating' — a day left claiming to be
  // running is a spinner forever.
  expect(day.data()?.detailStatus).toBe('pending')
  expect(day.data()?.detailError).toBeTruthy()
})

// Absent means ready. Every day written before the split carries its detail
// already, and a trip planned last week must not come back looking like it
// lost half of itself.
test('a day from before the split shows no gate at all', async ({ page }) => {
  const tripId = await createTripWithPlan(page)
  const dayId = await getDayIdByDate(tripId, '2026-07-10')

  await page.goto(`/map/day/${dayId}`)
  await page.getByTestId('day-view').waitFor()

  await expect(page.getByTestId('activities-row')).toBeVisible()
  await expect(page.getByTestId('day-detail-gate')).toHaveCount(0)
})
