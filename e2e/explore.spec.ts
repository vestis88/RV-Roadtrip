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

test('voting reorders within a priority tier, and lock/reject change status', async ({
  page,
}) => {
  const tripId = await getTripId(page)
  await seedCandidate(tripId, { name: 'Otta', rank: 0 })
  await seedCandidate(tripId, { name: 'Lillehammer', rank: 1 })

  await page.getByTestId('nav-map').click()
  await page.getByTestId('explore-map-screen').waitFor()

  const list = page.getByTestId('explore-candidate-list')
  await expect(list).toContainText('Otta')
  await expect(list).toContainText('Lillehammer')

  // Vote Lillehammer (rank 1) up past Otta (rank 0).
  const ottaSnap = await adminDb
    .collection('trips')
    .doc(tripId)
    .collection('corridorStops')
    .where('name', '==', 'Lillehammer')
    .limit(1)
    .get()
  const lillehammerId = ottaSnap.docs[0].id
  await page.getByTestId(`explore-candidate-up-${lillehammerId}`).click()

  await expect
    .poll(async () => {
      const snap = await adminDb
        .collection('trips')
        .doc(tripId)
        .collection('corridorStops')
        .doc(lillehammerId)
        .get()
      return snap.data()?.rank
    })
    .toBe(0)

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
