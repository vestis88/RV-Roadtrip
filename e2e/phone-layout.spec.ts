import { expect, test } from './fixtures.js'
import { createTripWithPlan } from './helpers/seedFixturePlan.js'

/**
 * Reported 2026-08-24 from an iPhone: "The iPhone view is now very limited
 * for scrolling the list at the bottom. The top should be further
 * compacted!"
 *
 * The header had been compacted for an iPad earlier the same day and was
 * measured there. At 390px the same five actions wrapped the row three times
 * over, and the totals took two more lines — so the list, which is the thing
 * you actually curate in, was left with a couple of card-heights.
 *
 * Asserted by geometry rather than by class name, the same call the iPad
 * split test makes: what breaks here is a layout that computes wrong, not a
 * utility that goes missing.
 */
test.use({ viewport: { width: 390, height: 844 } })

test('the phone header stays out of the list’s way', async ({ page }) => {
  await createTripWithPlan(page)
  await page.getByTestId('nav-map').click()
  await page.getByTestId('day-strip').waitFor()
  await page.getByTestId('explore-candidate-list').waitFor()

  // One row of actions, not three. A single `btn` is 44px plus the row's own
  // padding, so anything past ~80 means it has wrapped.
  const header = await page.getByTestId('explore-header').boundingBox()
  expect(header?.height ?? 0).toBeLessThan(80)

  // One line of numbers, not two.
  const totals = await page.getByTestId('explore-route-totals').boundingBox()
  expect(totals?.height ?? 0).toBeLessThan(50)

  // What it is all for: room to actually scroll the stops.
  const list = await page.getByTestId('explore-candidate-list').boundingBox()
  expect(list?.height ?? 0).toBeGreaterThan(240)
})

test('the plan actions are reachable behind More on a phone', async ({
  page,
}) => {
  await createTripWithPlan(page)
  await page.getByTestId('nav-map').click()
  await page.getByTestId('day-strip').waitFor()

  // Collapsed by default — that is what keeps the row to one line.
  await expect(page.getByTestId('request-changes-button')).toBeHidden()

  await page.getByTestId('more-plan-actions').click()
  await expect(page.getByTestId('request-changes-button')).toBeVisible()
  // "Edit route" and not "Rebuild day list": this fixture's stops are all
  // `committed`, and the rebuild button is offered only where there are
  // LOCKED stops to rebuild the days from. Asserting it here would have been
  // a claim about the fixture rather than about the disclosure.
  await expect(page.getByTestId('reorder-stops-button')).toBeVisible()

  // And they collapse again, rather than being a one-way door.
  await page.getByTestId('more-plan-actions').click()
  await expect(page.getByTestId('request-changes-button')).toBeHidden()
})

/**
 * The same actions must stay inline where there is room for them — that was
 * the point of putting them on one row in the first place ("put on same
 * row"), and a phone-shaped fix that also collapsed the iPad would have
 * undone it.
 */
test.describe('on a tablet', () => {
  test.use({ viewport: { width: 1180, height: 820 } })

  test('every action is inline, with no More button', async ({ page }) => {
    await createTripWithPlan(page)
    await page.getByTestId('nav-map').click()
    await page.getByTestId('day-strip').waitFor()

    await expect(page.getByTestId('request-changes-button')).toBeVisible()
    await expect(page.getByTestId('more-plan-actions')).toBeHidden()
  })
})

/**
 * Requested 2026-08-25: "There should be a filter for the list below the map.
 * Selecting only locked in, only must see, only not locked in or all."
 */
test.describe('filtering the list', () => {
  test.use({ viewport: { width: 1180, height: 820 } })

  test('each bucket shows what its count promises', async ({ page }) => {
    const { getFirestore } = await import('firebase-admin/firestore')
    const { getApps, initializeApp } = await import('firebase-admin/app')
    process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:8080'
    if (getApps().length === 0)
      initializeApp({ projectId: 'demo-rv-trip-planner' })
    const adminDb = getFirestore()

    const tripId = await createTripWithPlan(page)
    const stops = adminDb
      .collection('trips')
      .doc(tripId)
      .collection('corridorStops')
    const kept = await stops.add({
      name: 'Partnach Gorge',
      lat: 47.47,
      lng: 11.12,
      country: 'DE',
      status: 'locked',
      linkedDayIds: [],
      priority: 'worth-a-detour',
      rank: 0,
    })
    const loose = await stops.add({
      name: 'Eibsee',
      lat: 47.45,
      lng: 10.98,
      country: 'DE',
      status: 'candidate',
      linkedDayIds: [],
      priority: 'must-see',
      rank: 1,
    })

    await page.getByTestId('nav-map').click()
    await page.getByTestId('candidate-filter').waitFor()

    // This trip's dates are in the past, so it is not being travelled and
    // the list opens on everything — see the derived default.
    await expect(page.getByTestId(`explore-candidate-${kept.id}`)).toBeVisible()
    await expect(page.getByTestId(`explore-candidate-${loose.id}`)).toBeVisible()

    await page.getByTestId('candidate-filter-locked').click()
    await expect(page.getByTestId(`explore-candidate-${kept.id}`)).toBeVisible()
    await expect(page.getByTestId(`explore-candidate-${loose.id}`)).toHaveCount(0)

    await page.getByTestId('candidate-filter-unlocked').click()
    await expect(page.getByTestId(`explore-candidate-${kept.id}`)).toHaveCount(0)
    await expect(page.getByTestId(`explore-candidate-${loose.id}`)).toBeVisible()

    await page.getByTestId('candidate-filter-must-see').click()
    await expect(page.getByTestId(`explore-candidate-${loose.id}`)).toBeVisible()
    await expect(page.getByTestId(`explore-candidate-${kept.id}`)).toHaveCount(0)

    // The bucket that answers "I can't get to Day View for my locked stops":
    // in the route, but with no day behind it.
    await page.getByTestId('candidate-filter-no-day').click()
    await expect(page.getByTestId(`explore-candidate-${kept.id}`)).toBeVisible()
    await expect(
      page.getByTestId(`explore-candidate-build-days-${kept.id}`),
    ).toBeVisible()
  })
})

/**
 * Reported 2026-08-25: "The days on top are still som old irrelevant stuff.
 * I want info about today, tomorrow and so on."
 */
test.describe('the day strip', () => {
  test.use({ viewport: { width: 1180, height: 820 } })

  test('starts at today, with the earlier days tucked away', async ({
    page,
  }) => {
    const { getFirestore } = await import('firebase-admin/firestore')
    const { getApps, initializeApp } = await import('firebase-admin/app')
    process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:8080'
    if (getApps().length === 0)
      initializeApp({ projectId: 'demo-rv-trip-planner' })
    const adminDb = getFirestore()

    const tripId = await createTripWithPlan(page)

    // Re-date the fixture's three days around today, so the trip is running.
    const iso = (offset: number) =>
      new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10)
    const daysRef = adminDb.collection('trips').doc(tripId).collection('days')
    const snap = await daysRef.orderBy('index').get()
    await Promise.all(
      snap.docs.map((doc, index) => doc.ref.update({ date: iso(index - 1) })),
    )
    await adminDb
      .collection('trips')
      .doc(tripId)
      .update({
        'settings.startDate': iso(-1),
        'settings.endDate': iso(1),
      })

    await page.getByTestId('nav-map').click()
    const strip = page.getByTestId('day-strip')
    await strip.waitFor()

    await expect(strip).toContainText('Today')
    await expect(strip).toContainText('Tomorrow')
    // Yesterday is behind the reveal, not on screen.
    const yesterdayId = snap.docs[0].id
    await expect(page.getByTestId(`day-strip-${yesterdayId}`)).toHaveCount(0)

    await page.getByTestId('day-strip-show-past').click()
    await expect(page.getByTestId(`day-strip-${yesterdayId}`)).toBeVisible()
  })

  // Before the trip there is no "today" inside it, and relabelling would be
  // a lie — the strip is a plan, not a countdown.
  test('numbers the days while the trip is still ahead', async ({ page }) => {
    await createTripWithPlan(page)
    await page.getByTestId('nav-map').click()
    const strip = page.getByTestId('day-strip')
    await strip.waitFor()

    await expect(strip).toContainText('Day 1')
    await expect(page.getByTestId('day-strip-show-past')).toHaveCount(0)
  })

  /**
   * The "old irrelevant stuff" case: days from an earlier generation, and
   * kept stops that none of them mention.
   */
  test('says when the days do not include the kept stops', async ({ page }) => {
    const { getFirestore } = await import('firebase-admin/firestore')
    const { getApps, initializeApp } = await import('firebase-admin/app')
    process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:8080'
    if (getApps().length === 0)
      initializeApp({ projectId: 'demo-rv-trip-planner' })
    const adminDb = getFirestore()

    const tripId = await createTripWithPlan(page)
    await adminDb
      .collection('trips')
      .doc(tripId)
      .collection('corridorStops')
      .add({
        name: 'Partnach Gorge',
        lat: 47.47,
        lng: 11.12,
        country: 'DE',
        status: 'locked',
        linkedDayIds: [],
        priority: 'must-see',
        rank: 0,
      })

    await page.getByTestId('nav-map').click()
    const banner = page.getByTestId('days-out-of-step-banner')
    await expect(banner).toBeVisible({ timeout: 10_000 })
    await expect(banner).toContainText('earlier plan')

    await page.getByTestId('days-out-of-step-rebuild').click()
    await expect(page.getByTestId('rebuild-days-panel')).toBeVisible()
  })
})

/**
 * Requested 2026-08-25: "I want a button to go to my location. Then the zoom
 * could be like 5 km."
 *
 * The map opens on the traveler's position but only once, deliberately — a
 * GPS watch reports a fix every few seconds and re-centring on each would
 * drag the map out from under anyone looking elsewhere. That left no way
 * back after a pan, which is what this button is.
 */
test.describe('going back to my location', () => {
  test.use({
    viewport: { width: 390, height: 844 },
    permissions: ['geolocation'],
    geolocation: { latitude: 46.49, longitude: 11.34 },
  })

  /**
   * Presence only. What the button DOES needs a live Google map — `useMap`
   * returns null without one and this browser has no Maps key — so the
   * behaviour is unit-tested against a stubbed map instead. The same split
   * MarkerBadge already uses, and the same trap: the first version of this
   * asserted the button becomes enabled, which cannot happen in CI however
   * correct the code is.
   */
  test('is on the map, beside the other controls', async ({ page }) => {
    await createTripWithPlan(page)
    await page.getByTestId('nav-map').click()
    await page.getByTestId('explore-map-screen').waitFor()

    await expect(page.getByTestId('go-to-my-location')).toBeVisible()
  })
})

test.describe('with location refused', () => {
  test.use({ viewport: { width: 390, height: 844 } })

  test('the button is not offered at all', async ({ page, context }) => {
    await context.clearPermissions()
    await createTripWithPlan(page)
    await page.getByTestId('nav-map').click()
    await page.getByTestId('explore-map-screen').waitFor()

    // Inert without a fix. Whether it disappears entirely once permission is
    // actually REFUSED is unit-tested — clearing permissions here leaves the
    // answer merely unknown, not denied.
    await expect(page.getByTestId('go-to-my-location')).not.toBeEnabled()
  })
})

/**
 * The other half of the derived default: while planning, the list shows
 * everything. Opening on "Locked in" would hide the candidates on the screen
 * whose whole job is curation — and, worse, make them vanish the moment the
 * first one was locked.
 */
test.describe('while still planning', () => {
  test.use({ viewport: { width: 1180, height: 820 } })

  test('the list opens on everything', async ({ page }) => {
    const { getFirestore } = await import('firebase-admin/firestore')
    const { getApps, initializeApp } = await import('firebase-admin/app')
    process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:8080'
    if (getApps().length === 0)
      initializeApp({ projectId: 'demo-rv-trip-planner' })
    const adminDb = getFirestore()

    const tripId = await createTripWithPlan(page)
    const loose = await adminDb
      .collection('trips')
      .doc(tripId)
      .collection('corridorStops')
      .add({
        name: 'Eibsee',
        lat: 47.45,
        lng: 10.98,
        country: 'DE',
        status: 'candidate',
        linkedDayIds: [],
        priority: 'must-see',
        rank: 0,
      })

    await page.getByTestId('nav-map').click()
    await page.getByTestId('candidate-filter').waitFor()
    await expect(
      page.getByTestId(`explore-candidate-${loose.id}`),
    ).toBeVisible()
  })
})

/**
 * And on the road it is a to-do: what is kept and still ahead, not twenty
 * suggestions between the stops you committed to. Requested 2026-08-25:
 * "The list should be locked in not done."
 */
test.describe('once the trip is under way', () => {
  test.use({
    viewport: { width: 1180, height: 820 },
    // Dates alone are not enough — a trip created today spans today. Being
    // somewhere on it, with a fix, is what makes this the road rather than
    // the kitchen table.
    permissions: ['geolocation'],
    geolocation: { latitude: 47.47, longitude: 11.12 },
  })

  test('the list opens on what is kept', async ({ page }) => {
    const { getFirestore } = await import('firebase-admin/firestore')
    const { getApps, initializeApp } = await import('firebase-admin/app')
    process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:8080'
    if (getApps().length === 0)
      initializeApp({ projectId: 'demo-rv-trip-planner' })
    const adminDb = getFirestore()

    const tripId = await createTripWithPlan(page)
    const iso = (offset: number) =>
      new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10)
    await adminDb
      .collection('trips')
      .doc(tripId)
      .update({ 'settings.startDate': iso(-1), 'settings.endDate': iso(5) })

    const stops = adminDb
      .collection('trips')
      .doc(tripId)
      .collection('corridorStops')
    const kept = await stops.add({
      name: 'Partnach Gorge',
      lat: 47.47,
      lng: 11.12,
      country: 'DE',
      status: 'locked',
      linkedDayIds: [],
      priority: 'worth-a-detour',
      rank: 0,
    })
    const loose = await stops.add({
      name: 'Eibsee',
      lat: 47.45,
      lng: 10.98,
      country: 'DE',
      status: 'candidate',
      linkedDayIds: [],
      priority: 'must-see',
      rank: 1,
    })

    await page.getByTestId('nav-map').click()
    await page.getByTestId('candidate-filter').waitFor()

    await expect(page.getByTestId(`explore-candidate-${kept.id}`)).toBeVisible()
    await expect(
      page.getByTestId(`explore-candidate-${loose.id}`),
    ).toHaveCount(0, { timeout: 15_000 })
  })
})
