import { expect, test } from './fixtures.js'
import { getApps, initializeApp } from 'firebase-admin/app'
import { getFirestore } from 'firebase-admin/firestore'
import { evaluateWithRetry } from './helpers/seedFixturePlan.js'

process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:8080'
const PROJECT_ID = 'demo-rv-trip-planner'
if (getApps().length === 0) initializeApp({ projectId: PROJECT_ID })
const adminDb = getFirestore()

async function getTripId(page: import('@playwright/test').Page): Promise<string> {
  await page.goto('/')
  await page.getByTestId('trip-name-input').waitFor()
  const tripId = await evaluateWithRetry(page, () => localStorage.getItem('tripId'))
  if (!tripId) throw new Error('tripId missing from localStorage')
  return tripId
}

async function seedCandidate(
  tripId: string,
  overrides: Partial<{
    name: string
    priority: 'must-see' | 'worth-a-detour' | 'nice-if-convenient'
    rank: number
  }> = {},
) {
  await adminDb
    .collection('trips')
    .doc(tripId)
    .collection('corridorStops')
    .add({
      name: overrides.name ?? 'Otta',
      lat: 61.77,
      lng: 9.54,
      country: 'NO',
      why: 'A local favourite.',
      status: 'candidate',
      linkedDayIds: [],
      priority: overrides.priority ?? 'must-see',
      region: 'Gudbrandsdalen',
      rank: overrides.rank ?? 0,
    })
}

test('explore mode shows an empty state and a working "find great stops" degradation', async ({
  page,
}) => {
  const tripId = await getTripId(page)
  // A route is required before this spends a Claude call — see the
  // dedicated guard test below. Seeded directly rather than through the
  // Places autocomplete so this test stays focused on the degradation path.
  await adminDb
    .collection('trips')
    .doc(tripId)
    .update({
      'settings.startPoint': { name: 'Oslo, Norway', lat: 59.91, lng: 10.75 },
      'settings.endPoint': { name: 'Bergen, Norway', lat: 60.39, lng: 5.32 },
    })

  await page.getByTestId('nav-map').click()
  await page.getByTestId('explore-map-screen').waitFor()

  await expect(page.getByTestId('explore-candidate-list')).toContainText('No stops yet')

  // No CLAUDE_API_KEY in this sandbox — same credential-less degradation
  // every other Claude-touching e2e test in this suite exercises.
  await page.getByTestId('explore-find-stops-button').click()
  await expect(page.getByTestId('explore-find-stops-error')).toContainText(
    'Could not find stops',
    { timeout: 10_000 },
  )
  expect(tripId).toBeTruthy()
})

// Regression: "Generate overview" (Trip Setup) navigates to /map on
// success, mounting this screen fresh — a genuinely empty result (a
// short/local trip legitimately having nothing to flag) must not read as
// "you haven't searched yet" just because this screen never fired the
// call itself. planMeta.exploreLastRunAt (set server-side by a completed
// run, regardless of which screen triggered it) is what this message
// branches on instead of local component state.
test('a completed search that found nothing shows a different message than never having searched', async ({
  page,
}) => {
  const tripId = await getTripId(page)
  await adminDb
    .collection('trips')
    .doc(tripId)
    .update({
      'settings.startPoint': { name: 'Oslo, Norway', lat: 59.91, lng: 10.75 },
      'settings.endPoint': { name: 'Bergen, Norway', lat: 60.39, lng: 5.32 },
      'planMeta.exploreLastRunAt': new Date().toISOString(),
    })

  await page.getByTestId('nav-map').click()
  await page.getByTestId('explore-map-screen').waitFor()

  await expect(page.getByTestId('explore-empty-state')).toContainText(
    'Nothing stood out along this route',
  )
  await expect(page.getByTestId('explore-empty-state')).not.toContainText(
    'No stops yet',
  )
})

test('"Find great stops" requires a start and finish point first', async ({ page }) => {
  await getTripId(page)
  await page.getByTestId('nav-map').click()
  await page.getByTestId('explore-map-screen').waitFor()

  // A brand-new trip starts with both points blank — reported as this
  // button silently returning 0 stops with no explanation, since (0, 0)
  // still looks like a real coordinate downstream.
  await page.getByTestId('explore-find-stops-button').click()
  await expect(page.getByTestId('explore-find-stops-error')).toContainText(
    'start and finish point',
  )
})

test('voting moves a stop a whole category, and lock/reject change status', async ({
  page,
}) => {
  const tripId = await getTripId(page)
  await seedCandidate(tripId, { name: 'Otta', rank: 0 })
  await seedCandidate(tripId, {
    name: 'Lillehammer',
    priority: 'nice-if-convenient',
    rank: 1,
  })

  await page.getByTestId('nav-map').click()
  await page.getByTestId('explore-map-screen').waitFor()

  const list = page.getByTestId('explore-candidate-list')
  await expect(list).toContainText('Otta')
  await expect(list).toContainText('Lillehammer')

  const ottaSnap = await adminDb
    .collection('trips')
    .doc(tripId)
    .collection('corridorStops')
    .where('name', '==', 'Lillehammer')
    .limit(1)
    .get()
  const lillehammerId = ottaSnap.docs[0].id
  await page.getByTestId(`explore-candidate-up-${lillehammerId}`).click()

  // One vote, one whole category — not a rank shuffle inside the same one.
  await expect
    .poll(async () => {
      const snap = await adminDb
        .collection('trips')
        .doc(tripId)
        .collection('corridorStops')
        .doc(lillehammerId)
        .get()
      return snap.data()?.priority
    })
    .toBe('worth-a-detour')

  await page.getByTestId(`explore-candidate-lock-${lillehammerId}`).click()
  await expect
    .poll(async () => {
      const snap = await adminDb
        .collection('trips')
        .doc(tripId)
        .collection('corridorStops')
        .doc(lillehammerId)
        .get()
      return snap.data()?.status
    })
    .toBe('locked')

  const ottaId = (
    await adminDb
      .collection('trips')
      .doc(tripId)
      .collection('corridorStops')
      .where('name', '==', 'Otta')
      .limit(1)
      .get()
  ).docs[0].id
  await page.getByTestId(`explore-candidate-reject-${ottaId}`).click()
  await expect
    .poll(async () => {
      const snap = await adminDb
        .collection('trips')
        .doc(tripId)
        .collection('corridorStops')
        .doc(ottaId)
        .get()
      return snap.exists
    })
    .toBe(false)
})

// Keeping a stop is explore mode's counterpart of selecting a place in Day
// View, so it wears the same colour (asked for 2026-08-02) — the same
// border-sky-600 that manual-editing.spec.ts asserts on an activity card,
// and that this stop's own map pin already used while its card was green.
test('keeping a stop marks it with the same blue as a selected place, distinct from tapping', async ({
  page,
}) => {
  const tripId = await getTripId(page)
  await seedCandidate(tripId, { name: 'Otta', priority: 'must-see', rank: 0 })

  await page.getByTestId('nav-map').click()
  await page.getByTestId('explore-map-screen').waitFor()

  const stops = adminDb.collection('trips').doc(tripId).collection('corridorStops')
  const ottaId = (await stops.where('name', '==', 'Otta').limit(1).get()).docs[0].id
  const card = page.getByTestId(`explore-candidate-${ottaId}`)

  await expect(card).not.toHaveClass(/border-sky-600/)
  await expect(card).not.toHaveClass(/border-orange-600/)

  await page.getByTestId(`explore-candidate-lock-${ottaId}`).click()
  await expect(card).toHaveClass(/border-sky-600/)

  // Tap-to-view stays a separate, orange highlight — keeping alone must not
  // trigger it, and tapping takes visual priority once it does.
  await expect(card).not.toHaveClass(/border-orange-600/)
  await card.click()
  await expect(card).toHaveClass(/border-orange-600/)
})

// Regression: "the promote/demote does not seem to work. Everything should
// be possible to promote/demote" — a vote used to only swap rank inside one
// tier, so the top and bottom stop of every tier had both buttons disabled
// and nothing could ever change priority.
test('promoting a stop moves it into the category above', async ({
  page,
}) => {
  const tripId = await getTripId(page)
  await seedCandidate(tripId, { name: 'Otta', priority: 'must-see', rank: 0 })
  await seedCandidate(tripId, {
    name: 'Lillehammer',
    priority: 'worth-a-detour',
    rank: 0,
  })

  await page.getByTestId('nav-map').click()
  await page.getByTestId('explore-map-screen').waitFor()

  const stops = adminDb.collection('trips').doc(tripId).collection('corridorStops')
  const lillehammerId = (
    await stops.where('name', '==', 'Lillehammer').limit(1).get()
  ).docs[0].id

  // Sole occupant of worth-a-detour: previously this button was disabled.
  const up = page.getByTestId(`explore-candidate-up-${lillehammerId}`)
  await expect(up).toBeEnabled()
  await up.click()

  await expect
    .poll(async () => (await stops.doc(lillehammerId).get()).data()?.priority)
    .toBe('must-see')

  // Now must-see, it defines the route — so it reports as on-route rather
  // than carrying a detour estimate.
  await expect(
    page.getByTestId(`explore-candidate-onroute-${lillehammerId}`),
  ).toBeVisible()

  // ...and demoting puts it back.
  await page.getByTestId(`explore-candidate-down-${lillehammerId}`).click()
  await expect
    .poll(async () => (await stops.doc(lillehammerId).get()).data()?.priority)
    .toBe('worth-a-detour')
})

// A vote is a category move, so what disables an arrow is the stop's
// CATEGORY, never its position within one: every stop in must-see has a dead
// up arrow, including one sitting below a sibling.
test('only the top and bottom categories have a dead arrow, wherever a stop sits in them', async ({
  page,
}) => {
  const tripId = await getTripId(page)
  await seedCandidate(tripId, { name: 'Otta', priority: 'must-see', rank: 0 })
  await seedCandidate(tripId, { name: 'Dombås', priority: 'must-see', rank: 1 })
  await seedCandidate(tripId, {
    name: 'Lillehammer',
    priority: 'nice-if-convenient',
    rank: 0,
  })

  await page.getByTestId('nav-map').click()
  await page.getByTestId('explore-map-screen').waitFor()

  const stops = adminDb.collection('trips').doc(tripId).collection('corridorStops')
  const ottaId = (await stops.where('name', '==', 'Otta').limit(1).get()).docs[0].id
  const dombasId = (await stops.where('name', '==', 'Dombås').limit(1).get()).docs[0].id
  const lillehammerId = (
    await stops.where('name', '==', 'Lillehammer').limit(1).get()
  ).docs[0].id

  await expect(page.getByTestId(`explore-candidate-up-${ottaId}`)).toBeDisabled()
  await expect(page.getByTestId(`explore-candidate-down-${ottaId}`)).toBeEnabled()
  // Second in must-see, not first — still nowhere to be promoted to.
  await expect(page.getByTestId(`explore-candidate-up-${dombasId}`)).toBeDisabled()
  await expect(page.getByTestId(`explore-candidate-down-${dombasId}`)).toBeEnabled()
  await expect(
    page.getByTestId(`explore-candidate-down-${lillehammerId}`),
  ).toBeDisabled()
  await expect(page.getByTestId(`explore-candidate-up-${lillehammerId}`)).toBeEnabled()
})

test('generate-full-plan requires confirmation, and only fires a planRequest on confirm', async ({
  page,
}) => {
  const tripId = await getTripId(page)
  await seedCandidate(tripId)

  await page.getByTestId('nav-map').click()
  await page.getByTestId('explore-map-screen').waitFor()

  await page.getByTestId('explore-generate-plan-button').click()
  await page.getByTestId('confirm-generate-dialog').waitFor()

  await page.getByTestId('confirm-generate-cancel').click()
  await expect(page.getByTestId('confirm-generate-dialog')).toHaveCount(0)
  let requestsSnap = await adminDb
    .collection('planRequests')
    .where('tripId', '==', tripId)
    .get()
  expect(requestsSnap.empty).toBe(true)

  await page.getByTestId('explore-generate-plan-button').click()
  await page.getByTestId('confirm-generate-confirm').click()

  await expect
    .poll(async () => {
      requestsSnap = await adminDb
        .collection('planRequests')
        .where('tripId', '==', tripId)
        .get()
      return requestsSnap.size
    })
    .toBe(1)
  expect(requestsSnap.docs[0].data().kind).toBe('fromExploreCandidates')
})
