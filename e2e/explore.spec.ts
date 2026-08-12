import { expect, test } from './fixtures.js'
import { getApps, initializeApp } from 'firebase-admin/app'
import { getFirestore } from 'firebase-admin/firestore'
import { evaluateWithRetry } from './helpers/seedFixturePlan.js'
import { signIn } from './helpers/signIn.js'

process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:8080'
const PROJECT_ID = 'demo-rv-trip-planner'
if (getApps().length === 0) initializeApp({ projectId: PROJECT_ID })
const adminDb = getFirestore()

async function getTripId(page: import('@playwright/test').Page): Promise<string> {
  await signIn(page)
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
    lat: number
    lng: number
  }> = {},
) {
  await adminDb
    .collection('trips')
    .doc(tripId)
    .collection('corridorStops')
    .add({
      name: overrides.name ?? 'Otta',
      lat: overrides.lat ?? 61.77,
      lng: overrides.lng ?? 9.54,
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

test('the interest selector sets a level, and lock/reject change status', async ({
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
  await page
    .getByTestId(`explore-candidate-interest-worth-a-detour-${lillehammerId}`)
    .click()

  // One tap, whichever level was picked — no stepping through the one
  // between.
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

// Voting and keeping are different decisions, and only keeping moves the
// route. Both used to: a stop voted to must-see was silently added to the
// backbone, which meant two unrelated controls did the same thing and the
// card only ever admitted to one of them — a must-see stop wore the blue
// ring but showed no "Keeping" chip and still offered a "Keep this" button
// that changed nothing visible. Votes are triage now; keeping is the
// commitment.
test('marking a stop must-see does not put it in the route', async ({
  page,
}) => {
  const tripId = await getTripId(page)
  await seedCandidate(tripId, {
    name: 'Otta',
    priority: 'worth-a-detour',
    rank: 0,
  })

  await page.getByTestId('nav-map').click()
  await page.getByTestId('explore-map-screen').waitFor()

  const stops = adminDb.collection('trips').doc(tripId).collection('corridorStops')
  const ottaId = (await stops.where('name', '==', 'Otta').limit(1).get()).docs[0].id
  const card = page.getByTestId(`explore-candidate-${ottaId}`)

  // Off the route: neither colour.
  await expect(card).not.toHaveClass(/border-sky-600/)
  await expect(card).not.toHaveClass(/border-orange-600/)

  await page
    .getByTestId(`explore-candidate-interest-must-see-${ottaId}`)
    .click()
  await expect
    .poll(async () => (await stops.doc(ottaId).get()).data()?.priority)
    .toBe('must-see')

  // Top of the list, still not in the route: no blue, and it still reports a
  // detour because the route it would detour from hasn't changed.
  await expect(card).not.toHaveClass(/border-sky-600/)
  await expect(
    page.getByTestId(`explore-candidate-detour-${ottaId}`),
  ).toBeVisible()
  await expect(
    page.getByTestId(`explore-candidate-onroute-${ottaId}`),
  ).toBeHidden()

  // Keeping it is what commits it — and only then does it turn blue.
  await page.getByTestId(`explore-candidate-lock-${ottaId}`).click()
  await expect(card).toHaveClass(/border-sky-600/)

  // Tap-to-view stays a separate, orange highlight that takes priority.
  await expect(card).not.toHaveClass(/border-orange-600/)
  await card.click()
  await expect(card).toHaveClass(/border-orange-600/)
})

// Both figures come from the same straight-line estimate, so they are shown
// together in one chip — see estimateDriveMinutes on why no road factor is
// applied to the minutes.
test('a candidate reports its detour in both distance and time', async ({
  page,
}) => {
  const tripId = await getTripId(page)
  await seedCandidate(tripId, {
    name: 'Otta',
    priority: 'worth-a-detour',
    rank: 0,
  })

  await page.getByTestId('nav-map').click()
  await page.getByTestId('explore-map-screen').waitFor()

  const stops = adminDb.collection('trips').doc(tripId).collection('corridorStops')
  const ottaId = (await stops.where('name', '==', 'Otta').limit(1).get()).docs[0].id

  const detour = page.getByTestId(`explore-candidate-detour-${ottaId}`)
  await expect(detour).toContainText('km')
  await expect(detour).toHaveText(/\+\d+\s*(min|h)/)
})

// The original ask was photos from Google Maps. A link gets the traveler
// photos, reviews and opening hours without this app paying per photo load
// or putting its Places key in a scrapeable <img src> — and it works for
// stops already in Firestore, which a stored photo URL would not.
test('every candidate links out to Google Maps', async ({ page }) => {
  const tripId = await getTripId(page)
  await seedCandidate(tripId, { name: 'Otta', priority: 'must-see', rank: 0 })

  await page.getByTestId('nav-map').click()
  await page.getByTestId('explore-map-screen').waitFor()

  const stops = adminDb.collection('trips').doc(tripId).collection('corridorStops')
  const ottaDoc = (await stops.where('name', '==', 'Otta').limit(1).get()).docs[0]
  const { lat, lng } = ottaDoc.data() as { lat: number; lng: number }

  const link = page.getByTestId(`explore-candidate-maps-${ottaDoc.id}`)
  await expect(link).toHaveAttribute(
    'href',
    `https://www.google.com/maps/search/?api=1&query=${lat},${lng}`,
  )
  await expect(link).toHaveAttribute('target', '_blank')
  // Without noopener the opened tab gets a handle back to this one.
  await expect(link).toHaveAttribute('rel', /noopener/)
})

// Totals describe the committed route, so with nothing kept there is no
// route to describe — and "0 h" would read as a finding rather than an
// absence. The figures themselves need real Directions results, which the
// e2e environment has no key for; this asserts the gating, not the numbers.
test('route totals appear only once a stop is kept', async ({ page }) => {
  const tripId = await getTripId(page)
  await seedCandidate(tripId, {
    name: 'Otta',
    priority: 'must-see',
    rank: 0,
  })

  await page.getByTestId('nav-map').click()
  await page.getByTestId('explore-map-screen').waitFor()

  // Must-see but not kept: nothing is committed, so no totals bar.
  await expect(page.getByTestId('explore-route-totals')).toBeHidden()

  const stops = adminDb.collection('trips').doc(tripId).collection('corridorStops')
  const ottaId = (await stops.where('name', '==', 'Otta').limit(1).get()).docs[0].id
  await page.getByTestId(`explore-candidate-lock-${ottaId}`).click()

  const totals = page.getByTestId('explore-route-totals')
  await expect(totals).toBeVisible()
  await expect(totals).toContainText('1 kept stop')
})

test('keeping a stop turns it blue too, from any category', async ({ page }) => {
  const tripId = await getTripId(page)
  await seedCandidate(tripId, {
    name: 'Otta',
    priority: 'nice-if-convenient',
    rank: 0,
  })

  await page.getByTestId('nav-map').click()
  await page.getByTestId('explore-map-screen').waitFor()

  const stops = adminDb.collection('trips').doc(tripId).collection('corridorStops')
  const ottaId = (await stops.where('name', '==', 'Otta').limit(1).get()).docs[0].id
  const card = page.getByTestId(`explore-candidate-${ottaId}`)

  await expect(card).not.toHaveClass(/border-sky-600/)
  await page.getByTestId(`explore-candidate-lock-${ottaId}`).click()
  await expect(card).toHaveClass(/border-sky-600/)
})

// Reported 2026-08-11: "let us choose the interest level per item through a
// selecter." The up/down arrows this replaced moved one category per tap,
// and the category was also the stop's place in the list — so a stop in the
// middle of a tier needed several taps before anything appeared to happen.
test('the interest selector sets any level in one tap, in both directions', async ({
  page,
}) => {
  const tripId = await getTripId(page)
  await seedCandidate(tripId, {
    name: 'Lillehammer',
    priority: 'worth-a-detour',
  })

  await page.getByTestId('nav-map').click()
  await page.getByTestId('explore-map-screen').waitFor()

  const stops = adminDb.collection('trips').doc(tripId).collection('corridorStops')
  const id = (await stops.where('name', '==', 'Lillehammer').limit(1).get())
    .docs[0].id

  // Claude's own pick is what's selected until the traveler changes it.
  await expect(
    page.getByTestId(`explore-candidate-interest-worth-a-detour-${id}`),
  ).toHaveAttribute('aria-checked', 'true')

  // Straight to the bottom, skipping nothing — two arrow taps' worth of
  // movement in one.
  await page
    .getByTestId(`explore-candidate-interest-nice-if-convenient-${id}`)
    .click()
  await expect
    .poll(async () => (await stops.doc(id).get()).data()?.priority)
    .toBe('nice-if-convenient')

  // And straight back to the top.
  await page.getByTestId(`explore-candidate-interest-must-see-${id}`).click()
  await expect
    .poll(async () => (await stops.doc(id).get()).data()?.priority)
    .toBe('must-see')

  // Interest is triage, not commitment: the stop is still off the route, so
  // it still reports a detour rather than the on-route chip.
  await expect(
    page.getByTestId(`explore-candidate-detour-${id}`),
  ).toBeVisible()
})

// Reported 2026-08-11: "ordering by must see, worth a detour and so on"
// answered a question the traveler already had answered on each card, while
// the one they actually had — is this before or after Hamburg — took
// cross-referencing three sections against the map.
test('the list runs in route order, whatever each stop\'s interest level', async ({
  page,
}) => {
  const tripId = await getTripId(page)
  // Oslo (59.91, 10.75) to Bergen (60.39, 5.32) — seeded below. Interest
  // level runs deliberately opposite to route order, so a list still sorted
  // by category would come out exactly backwards.
  await seedCandidate(tripId, {
    name: 'Third',
    lat: 60.3,
    lng: 6.0,
    priority: 'must-see',
  })
  await seedCandidate(tripId, {
    name: 'First',
    lat: 60.0,
    lng: 10.0,
    priority: 'nice-if-convenient',
  })
  await seedCandidate(tripId, {
    name: 'Second',
    lat: 60.15,
    lng: 8.0,
    priority: 'worth-a-detour',
  })
  await adminDb
    .collection('trips')
    .doc(tripId)
    .update({
      'settings.startPoint': { name: 'Oslo, Norway', lat: 59.91, lng: 10.75 },
      'settings.endPoint': { name: 'Bergen, Norway', lat: 60.39, lng: 5.32 },
    })

  await page.getByTestId('nav-map').click()
  await page.getByTestId('explore-map-screen').waitFor()

  const cards = page
    .getByTestId('explore-candidate-list')
    .locator('[role="button"][data-testid^="explore-candidate-"]')
  await expect(cards).toHaveCount(3)
  await expect(cards.nth(0)).toContainText('First')
  await expect(cards.nth(1)).toContainText('Second')
  await expect(cards.nth(2)).toContainText('Third')

  // No category headings left to group under.
  await expect(page.getByTestId('explore-candidate-list')).not.toContainText(
    'Nice if convenient',
  )
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
