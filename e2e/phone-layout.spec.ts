import { expect, test } from './fixtures.js'
import {
  createTripWithPlan,
  getDayIdByDate,
} from './helpers/seedFixturePlan.js'

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

  // What it is all for: room to actually scroll the stops. Raised from 240
  // on 2026-08-26 when the map came down to 35vh on phones — "On iPhone, the
  // map keeps being to dominant."
  const list = await page.getByTestId('explore-candidate-list').boundingBox()
  expect(list?.height ?? 0).toBeGreaterThan(330)

  // And the map is still a map, not a texture.
  const map = await page.getByTestId('explore-map-screen').boundingBox()
  expect(map?.height ?? 0).toBeGreaterThan(0)
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
/**
 * Marks the seeded plan's days as carrying no research.
 *
 * The fixture writes activities and restaurants but no `detailStatus`, and
 * an ABSENT status means READY (tripDaySchema says so) — so by default every
 * fixture day now reads as researched, which is truthful. A spec about the
 * free path has to say it means bare, rather than relying on a field being
 * missing.
 */
async function markDaysUnresearched(
  adminDb: FirebaseFirestore.Firestore,
  tripId: string,
  except: string[] = [],
): Promise<void> {
  const days = await adminDb
    .collection('trips')
    .doc(tripId)
    .collection('days')
    .get()
  await Promise.all(
    days.docs
      .filter((day) => !except.includes(day.id))
      .map((day) => day.ref.update({ detailStatus: 'pending' })),
  )
}

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

    // The fixture's days carry activities and restaurants but no
    // `detailStatus`, so the automatic skeleton writer treats them as its
    // own and rebuilds over them — which now also LINKS the locked stop to
    // a day and empties the bucket this test is about. Marked ready, which
    // is what a generated day really carries, so the writer stands aside
    // and the new stop is genuinely day-less: exactly the case the bucket
    // exists for, a locked find added to a trip that was already planned.
    const seededDays = await adminDb
      .collection('trips')
      .doc(tripId)
      .collection('days')
      .get()
    await Promise.all(
      seededDays.docs.map((day) => day.ref.update({ detailStatus: 'ready' })),
    )

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

    // The banner survives at all only because these days would be LOST:
    // they carry activities and restaurants, none of them are anywhere near
    // the kept stop, and the writer that would otherwise fix this silently
    // stands aside rather than discard them. So this is the one case that
    // still asks (2026-08-31, "remove having to rebuild days").
    await page.getByTestId('days-out-of-step-rebuild').click()
    await expect(page.getByTestId('rebuild-days-panel')).toBeVisible()
    await expect(page.getByTestId('rebuild-days-cost')).toContainText(
      'no longer on the route',
    )
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

/**
 * Reported 2026-08-26: "'today' should reflect the closest not marked done
 * activity. Now it's some other far away location." The chip read an
 * overnight town from an older plan, 200 km from where the van was parked.
 */
test.describe('what today is about', () => {
  test.use({
    viewport: { width: 1180, height: 820 },
    permissions: ['geolocation'],
    geolocation: { latitude: 46.53, longitude: 11.6 },
  })

  test('reads the board when the stored days do not match it', async ({
    page,
  }) => {
    const { getFirestore } = await import('firebase-admin/firestore')
    const { getApps, initializeApp } = await import('firebase-admin/app')
    process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:8080'
    if (getApps().length === 0)
      initializeApp({ projectId: 'demo-rv-trip-planner' })
    const adminDb = getFirestore()

    const tripId = await createTripWithPlan(page)
    const iso = (offset: number) =>
      new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10)
    const daysRef = adminDb.collection('trips').doc(tripId).collection('days')
    const snap = await daysRef.orderBy('index').get()
    await Promise.all(
      snap.docs.map((doc, index) => doc.ref.update({ date: iso(index) })),
    )
    await adminDb
      .collection('trips')
      .doc(tripId)
      .update({ 'settings.startDate': iso(0), 'settings.endDate': iso(5) })

    // Right where the van is, and still to do.
    await adminDb
      .collection('trips')
      .doc(tripId)
      .collection('corridorStops')
      .add({
        name: 'Seiser Alm Bahn',
        lat: 46.53,
        lng: 11.6,
        country: 'IT',
        status: 'locked',
        linkedDayIds: [],
        priority: 'must-see',
        rank: 0,
      })

    // And one further along, which the stale days date into the PAST — the
    // reported symptom: "Kronplatz ... is also shown as earlier, even though
    // it's clearly marked as next on the map."
    await adminDb
      .collection('trips')
      .doc(tripId)
      .collection('corridorStops')
      .add({
        name: 'Kronplatz Bikepark',
        lat: 46.74,
        lng: 11.95,
        country: 'IT',
        status: 'locked',
        linkedDayIds: [],
        priority: 'must-see',
        rank: 1,
      })

    await page.getByTestId('nav-map').click()
    const strip = page.getByTestId('day-strip')
    await strip.waitFor()

    // The strip now names the kept stops, not the older plan's overnights.
    await expect(strip).toContainText('Seiser Alm Bahn', { timeout: 15_000 })
    await expect(strip).toContainText('Kronplatz Bikepark')
    await expect(strip).toContainText('Today')
    // Nothing still to do is dated into the past.
    await expect(strip).not.toContainText('earlier')
  })
})

/**
 * Reported 2026-08-26: "Now there are two rebuild days on the same screen.
 * Which to push?" — the banner's button had opened the panel and then stayed,
 * looking like a second, different action.
 */
test.describe('opening the rebuild', () => {
  test.use({ viewport: { width: 1180, height: 820 } })

  test('leaves only the panel, not the button that opened it', async ({
    page,
  }) => {
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
    // A researched day nowhere near the kept stop, so this rebuild really
    // does cost something and the confirmation appears at all — a free one
    // no longer asks (2026-08-31, "this warning is still showing").
    const dayId = await getDayIdByDate(tripId, '2026-07-10')
    await adminDb
      .collection('trips')
      .doc(tripId)
      .collection('days')
      .doc(dayId)
      .update({ detailStatus: 'ready' })

    await page.getByTestId('nav-map').click()
    await page.getByTestId('days-out-of-step-rebuild').waitFor()
    await page.getByTestId('days-out-of-step-rebuild').click()

    await expect(page.getByTestId('rebuild-days-panel')).toBeVisible()
    // Both triggers stand down while their own panel is up.
    await expect(page.getByTestId('days-out-of-step-rebuild')).toHaveCount(0)
    await expect(page.getByTestId('rebuild-days-button')).toHaveCount(0)

    // And they come back once it is dismissed, rather than being lost.
    await page.getByTestId('rebuild-days-cancel').click()
    await expect(page.getByTestId('days-out-of-step-rebuild')).toBeVisible()
  })
})

/**
 * Reported 2026-08-26: "Previously clicking the button gave no visual
 * confirmation/progress info." The panel simply closed — and it is a button
 * that warns it will discard researched detail, so silence is a poor answer.
 */
test.describe('rebuilding the day list', () => {
  test.use({ viewport: { width: 1180, height: 820 } })

  test('says what it did', async ({ page }) => {
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
    await markDaysUnresearched(adminDb, tripId)

    await page.getByTestId('nav-map').click()
    await page.getByTestId('days-out-of-step-rebuild').waitFor()
    await page.getByTestId('days-out-of-step-rebuild').click()

    // One tap. Nothing here is discarded — the days carry no research — so
    // the rebuild does not stop to ask (2026-08-31, "this warning is still
    // showing", against a panel warning about nothing).
    await expect(page.getByTestId('rebuild-days-panel')).toHaveCount(0)

    // In words, not by inference from a strip the traveler was already
    // unsure about.
    const result = page.getByTestId('rebuild-days-result')
    await expect(result).toBeVisible({ timeout: 20_000 })
    await expect(result).toContainText('Day list rebuilt')
    await expect(result).toContainText('kept stop')

    // The panel is gone, and so is the banner it was answering.
    await expect(page.getByTestId('rebuild-days-panel')).toHaveCount(0)
    await expect(page.getByTestId('days-out-of-step-banner')).toHaveCount(0)

    // And the confirmation can be dismissed rather than sitting there.
    await page.getByTestId('rebuild-days-result-dismiss').click()
    await expect(result).toHaveCount(0)
  })
})

/**
 * Reported 2026-08-31 with a screenshot: "Used rescan this area. Said it
 * found 7 results. Can't see any."
 *
 * They were written — the count a scan reports IS the number of documents it
 * committed — into a list filtered to "Locked in", which a stop written
 * seconds ago can never be. The scan says "found 7" on the map; the results
 * land in the column below, behind a filter the scan knew nothing about.
 */
test.describe('a scan whose results the list is hiding', () => {
  test.use({ viewport: { width: 1180, height: 820 } })

  test('says where they went, and offers to show them', async ({ page }) => {
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
    await stops.add({
      name: 'Paganella Bike Dolomites',
      lat: 46.14,
      lng: 11.0,
      country: 'IT',
      status: 'locked',
      linkedDayIds: [],
    })
    // What a rescan writes once a plan exists: never locked, never done,
    // no day, no priority.
    const scanned = await stops.add({
      name: 'Cascata del Varone',
      lat: 45.9,
      lng: 10.85,
      country: 'IT',
      status: 'proposed',
      origin: 'traveler',
      linkedDayIds: [],
    })
    // The trip's own record of the scan that just finished — the same
    // fields runRescanCorridor writes, which is what the result line reads.
    await adminDb.collection('trips').doc(tripId).update({
      'planMeta.rescanStatus': 'idle',
      'planMeta.rescanLastRunAt': new Date().toISOString(),
      'planMeta.rescanLastFoundCount': 7,
      'planMeta.rescanLastDroppedTooFar': 0,
      'planMeta.rescanLastNotLocated': 0,
      'planMeta.rescanLastRadiusKm': 26,
    })

    await page.getByTestId('nav-map').click()
    await page.getByTestId('candidate-filter').waitFor()
    await page.getByTestId('candidate-filter-locked').click()

    // The complaint, exactly: a count on the map and nothing in the list.
    await expect(page.getByTestId('rescan-corridor-status')).toContainText(
      'Found 7 new stops nearby',
    )
    await expect(
      page.getByTestId(`explore-candidate-${scanned.id}`),
    ).toHaveCount(0)

    await expect(page.getByTestId('scan-results-hidden')).toContainText(
      'Not locked',
    )
    // Switching to another bucket that ALSO hides them is not reading the
    // message — it is the same problem again, so the message stays. ("No
    // day yet" needs a locked stop, which the scan's finds can never be.)
    await page.getByTestId('candidate-filter-no-day').click()
    await expect(page.getByTestId('scan-results-hidden')).toBeVisible()

    await page.getByTestId('show-scan-results').click()

    await expect(
      page.getByTestId(`explore-candidate-${scanned.id}`),
    ).toBeVisible()
    // And the notice retires the moment it stops being true.
    await expect(page.getByTestId('scan-results-hidden')).toHaveCount(0)
  })

  /**
   * The root cause underneath the filter, and the reason "All" would not
   * have helped either: a rescan writes `candidate` only while the trip has
   * no plan, and `proposed` once it has one — and the board's list was built
   * from `candidate` and `locked` alone. So on any trip past generation,
   * "rescan this area" wrote to a collection nothing rendered.
   */
  test('shows a rescan find on a trip that already has a plan', async ({
    page,
  }) => {
    const { getFirestore } = await import('firebase-admin/firestore')
    const { getApps, initializeApp } = await import('firebase-admin/app')
    process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:8080'
    if (getApps().length === 0)
      initializeApp({ projectId: 'demo-rv-trip-planner' })
    const adminDb = getFirestore()

    const tripId = await createTripWithPlan(page)
    const scanned = await adminDb
      .collection('trips')
      .doc(tripId)
      .collection('corridorStops')
      .add({
        name: 'Cascata del Varone',
        lat: 45.9,
        lng: 10.85,
        country: 'IT',
        status: 'proposed',
        origin: 'traveler',
        linkedDayIds: [],
      })

    await page.getByTestId('nav-map').click()
    await expect(
      page.getByTestId(`explore-candidate-${scanned.id}`),
    ).toBeVisible()
    // With the action that makes it worth showing: a find you cannot keep is
    // no better than a find you cannot see.
    await expect(
      page.getByTestId(`explore-candidate-lock-${scanned.id}`),
    ).toBeVisible()
  })
})

/**
 * Asked on 2026-08-31: *"What does it have to discard? Can it not just keep
 * already generated days available?"*
 *
 * Mostly it does not have to. A day's researched activities and restaurants
 * belong to the place it is spent in, not to the date it was given, so a day
 * whose overnight survives the rebuild keeps them and only its dates move.
 * Firestore ids are also what a diary entry's `refPath` points at, so
 * keeping the day keeps the diary.
 */
test.describe('rebuilding without throwing away the research', () => {
  test.use({ viewport: { width: 1180, height: 820 } })

  test('keeps a kept stop’s day, its places and its diary entry', async ({
    page,
  }) => {
    const { getFirestore } = await import('firebase-admin/firestore')
    const { getApps, initializeApp } = await import('firebase-admin/app')
    process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:8080'
    if (getApps().length === 0)
      initializeApp({ projectId: 'demo-rv-trip-planner' })
    const adminDb = getFirestore()

    const tripId = await createTripWithPlan(page)
    const tripRef = adminDb.collection('trips').doc(tripId)

    // A locked stop standing exactly where one of the seeded days sleeps —
    // so the rebuild packs a day onto the same place the stored one has.
    await tripRef.collection('corridorStops').add({
      name: 'Lillehammer Camping',
      lat: 61.1153,
      lng: 10.4662,
      country: 'NO',
      status: 'locked',
      linkedDayIds: [],
    })
    const dayId = await getDayIdByDate(tripId, '2026-07-10')
    const dayRef = tripRef.collection('days').doc(dayId)
    await dayRef.update({ detailStatus: 'ready' })
    // The other seeded days go nowhere near the kept stop; left as
    // researched they would be a real loss and the rebuild would rightly
    // stop to ask. This spec is about the day that SURVIVES.
    await markDaysUnresearched(adminDb, tripId, [dayId])
    const activityBefore = (
      await dayRef.collection('activities').limit(1).get()
    ).docs[0]
    // A diary entry against that activity — the thing an id-churning rebuild
    // silently orphaned.
    await tripRef.collection('log').add({
      date: '2026-07-10',
      refType: 'activity',
      refPath: activityBefore.ref.path,
      note: 'Rained all afternoon, still worth it.',
      createdAt: new Date().toISOString(),
    })

    await page.getByTestId('nav-map').click()
    await page.getByTestId('days-out-of-step-rebuild').waitFor()
    await page.getByTestId('days-out-of-step-rebuild').click()

    // Nothing is discarded here, so nothing is asked: the confirmation
    // exists to let someone refuse, and there is nothing to refuse.
    await expect(page.getByTestId('rebuild-days-panel')).toHaveCount(0)
    await expect(page.getByTestId('rebuild-days-result')).toBeVisible({
      timeout: 20_000,
    })

    // Read back from the server, not the client's own optimistic view.
    await expect
      .poll(async () => (await dayRef.get()).exists, { timeout: 15_000 })
      .toBe(true)
    const after = await dayRef.get()
    // Its research is untouched...
    expect(after.data()?.detailStatus).toBe('ready')
    expect((await dayRef.collection('activities').get()).size).toBeGreaterThan(0)
    expect((await activityBefore.ref.get()).exists).toBe(true)
    // ...and the diary entry still points at something that exists.
    const logged = await tripRef.collection('log').get()
    expect(logged.docs).toHaveLength(1)
    expect(
      (await adminDb.doc(logged.docs[0].data().refPath).get()).exists,
    ).toBe(true)
    // The one thing that DID change: where it sits in the itinerary.
    expect(after.data()?.index).toBe(0)
  })
})

/**
 * Reported 2026-08-31 with a screenshot: *"This list on top seems completely
 * obsolete!"* — five pacing warnings about Day 1 (2026-08-20, Rothenburg ob
 * der Tauber), Day 2 (Neuschwanstein), Day 6 (Lake Lucerne), read from a
 * campsite in the Dolomites on the 31st.
 *
 * Every one was true when written and every one described a day the traveler
 * had driven past a week and a half earlier. Pacing advice is about a
 * decision — "either the drive moves to another day or the sight does" —
 * which can only be taken before the day happens.
 */
test.describe('pacing advice about days already driven', () => {
  test.use({ viewport: { width: 1180, height: 820 } })

  test('expires, while advice about the days ahead stays', async ({ page }) => {
    const { getFirestore } = await import('firebase-admin/firestore')
    const { getApps, initializeApp } = await import('firebase-admin/app')
    process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:8080'
    if (getApps().length === 0)
      initializeApp({ projectId: 'demo-rv-trip-planner' })
    const adminDb = getFirestore()

    const tripId = await createTripWithPlan(page)
    const yesterday = new Date(Date.now() - 86_400_000)
      .toISOString()
      .slice(0, 10)
    const nextWeek = new Date(Date.now() + 7 * 86_400_000)
      .toISOString()
      .slice(0, 10)
    await adminDb
      .collection('trips')
      .doc(tripId)
      .update({
        'planMeta.pacingWarnings': [
          `Day 1 (${yesterday}) drives 581 km and is also the day for Rothenburg ob der Tauber, a half-day sight.`,
          `Day 20 (${nextWeek}) drives 264 km and is also the day for il Mercato Centrale Firenze.`,
          'The second half of the trip carries most of the driving.',
        ],
      })

    await page.getByTestId('nav-map').click()
    const banner = page.getByTestId('pacing-warning-banner')
    await banner.waitFor()

    await expect(banner).toContainText('Mercato Centrale')
    // The whole-trip warning names no day and never went stale.
    await expect(banner).toContainText('second half of the trip')
    // The one about a day already behind them is gone.
    await expect(banner).not.toContainText('Rothenburg')
  })
})

/**
 * Requested 2026-08-31: *"Fix it and remove having to rebuild days. I want
 * days to organically create themselves based on the planned activities and
 * their duration continuously."*
 *
 * The writer that derives days from the board used to stand aside whenever
 * ANY day carried research — right while a rebuild deleted every day, and
 * wrong once days are reused by overnight, because it froze the day list on
 * every generated trip and left the traveler pressing a button to keep their
 * own itinerary current. It now stands aside only when a rebuild would
 * DISCARD research, which is the one case worth a decision.
 */
test.describe('days that keep themselves current', () => {
  test.use({ viewport: { width: 1180, height: 820 } })

  test('follow a newly kept stop with nothing pressed', async ({ page }) => {
    const { getFirestore } = await import('firebase-admin/firestore')
    const { getApps, initializeApp } = await import('firebase-admin/app')
    process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:8080'
    if (getApps().length === 0)
      initializeApp({ projectId: 'demo-rv-trip-planner' })
    const adminDb = getFirestore()

    const tripId = await createTripWithPlan(page)
    // The seeded plan, with its research still on the day that survives —
    // this is a generated trip, which is exactly the case that used to be
    // frozen.
    const keptDayId = await getDayIdByDate(tripId, '2026-07-10')
    await markDaysUnresearched(adminDb, tripId, [keptDayId])
    await adminDb
      .collection('trips')
      .doc(tripId)
      .collection('corridorStops')
      .add({
        name: 'Lillehammer Camping',
        lat: 61.1153,
        lng: 10.4662,
        country: 'NO',
        status: 'locked',
        linkedDayIds: [],
      })

    await page.getByTestId('nav-map').click()

    // No banner to answer and no button to press: the day list has already
    // caught up with the board by the time anyone looks at it.
    await expect(page.getByTestId('day-strip')).toContainText('Lillehammer', {
      timeout: 20_000,
    })
    await expect(page.getByTestId('days-out-of-step-banner')).toHaveCount(0)
    await expect(page.getByTestId('rebuild-days-button')).toHaveCount(0)

    // And the research on the day that survived is still there.
    const dayRef = adminDb
      .collection('trips')
      .doc(tripId)
      .collection('days')
      .doc(keptDayId)
    await expect
      .poll(async () => (await dayRef.get()).exists, { timeout: 15_000 })
      .toBe(true)
    expect((await dayRef.collection('activities').get()).size).toBeGreaterThan(0)
  })
})

/**
 * Reported 2026-08-31: *"The information about the 7 added stops still shows
 * up. It should disappear after looking at any of the stops."*
 *
 * The result is written to the TRIP so it survives the phone that started
 * the scan going to sleep — and that is exactly why it had no natural end:
 * nothing in the trip document knows whether anyone has read it, so it sat
 * across the map hours later describing a scan already acted on.
 */
test.describe('a scan result that has been read', () => {
  test.use({ viewport: { width: 1180, height: 820 } })

  test('goes when the traveller looks at what it found', async ({ page }) => {
    const { getFirestore } = await import('firebase-admin/firestore')
    const { getApps, initializeApp } = await import('firebase-admin/app')
    process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:8080'
    if (getApps().length === 0)
      initializeApp({ projectId: 'demo-rv-trip-planner' })
    const adminDb = getFirestore()

    const tripId = await createTripWithPlan(page)
    const scanned = await adminDb
      .collection('trips')
      .doc(tripId)
      .collection('corridorStops')
      .add({
        name: 'Cascata del Varone',
        lat: 45.9,
        lng: 10.85,
        country: 'IT',
        status: 'proposed',
        origin: 'traveler',
        linkedDayIds: [],
      })
    await adminDb.collection('trips').doc(tripId).update({
      'planMeta.rescanStatus': 'idle',
      'planMeta.rescanLastRunAt': new Date().toISOString(),
      'planMeta.rescanLastFoundCount': 7,
      'planMeta.rescanLastDroppedTooFar': 0,
      'planMeta.rescanLastNotLocated': 0,
      'planMeta.rescanLastRadiusKm': 26,
    })

    await page.getByTestId('nav-map').click()
    const status = page.getByTestId('rescan-corridor-status')
    await expect(status).toContainText('Found 7 new stops nearby')

    // Opening one of them is reading the message. Clicked near the card's
    // corner rather than at its centre: the centre is one of the action
    // buttons, and those stop propagation so a tap on "Lock in" is not also
    // a tap on the card.
    const card = page.getByTestId(`explore-candidate-${scanned.id}`)
    await card.click({ position: { x: 8, y: 8 } })
    await expect(card).toHaveAttribute('aria-pressed', 'true')
    await expect(status).toHaveCount(0)

    // And it stays read across a relaunch — a scan result that has been
    // looked at is looked at for good, unlike the pacing banner's one say
    // per app launch.
    await page.reload()
    await page.getByTestId('candidate-filter').waitFor()
    await expect(page.getByTestId('rescan-corridor-status')).toHaveCount(0)
  })

  // The next scan is a new message, not the same one again.
  test('comes back for the scan after it', async ({ page }) => {
    const { getFirestore } = await import('firebase-admin/firestore')
    const { getApps, initializeApp } = await import('firebase-admin/app')
    process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:8080'
    if (getApps().length === 0)
      initializeApp({ projectId: 'demo-rv-trip-planner' })
    const adminDb = getFirestore()

    const tripId = await createTripWithPlan(page)
    const tripRef = adminDb.collection('trips').doc(tripId)
    const scanned = await tripRef.collection('corridorStops').add({
      name: 'Cascata del Varone',
      lat: 45.9,
      lng: 10.85,
      country: 'IT',
      status: 'proposed',
      origin: 'traveler',
      linkedDayIds: [],
    })
    await tripRef.update({
      'planMeta.rescanStatus': 'idle',
      'planMeta.rescanLastRunAt': '2026-08-31T20:16:00.000Z',
      'planMeta.rescanLastFoundCount': 7,
      'planMeta.rescanLastDroppedTooFar': 0,
      'planMeta.rescanLastNotLocated': 0,
      'planMeta.rescanLastRadiusKm': 26,
    })

    await page.getByTestId('nav-map').click()
    await page
      .getByTestId(`explore-candidate-${scanned.id}`)
      .click({ position: { x: 8, y: 8 } })
    await expect(page.getByTestId('rescan-corridor-status')).toHaveCount(0)

    await tripRef.update({
      'planMeta.rescanLastRunAt': '2026-08-31T21:40:00.000Z',
      'planMeta.rescanLastFoundCount': 3,
    })
    await expect(page.getByTestId('rescan-corridor-status')).toContainText(
      'Found 3 new stops nearby',
      { timeout: 15_000 },
    )
  })
})

/**
 * Reported 2026-08-31: *"Seems to not respond to any rebuilds… I can't enter
 * any days either!"* — with a green "Day list rebuilt — 4 days from your 6
 * kept stops" sitting directly above an amber "3 kept stops are not in them".
 *
 * Both were true. `planSkeleton` drops any stop whose country is not exactly
 * two letters, because a day's overnight must carry one — and a stop pinned
 * by hand never had a country written at all. So every traveler-placed pin
 * was invisible to the packer for good: no day, a banner counting it
 * forever, and a rebuild that could not possibly help.
 */
test.describe('a stop that was pinned without a country', () => {
  test.use({ viewport: { width: 1180, height: 820 } })

  test('is not offered a rebuild that cannot place it', async ({ page }) => {
    const { getFirestore } = await import('firebase-admin/firestore')
    const { getApps, initializeApp } = await import('firebase-admin/app')
    process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:8080'
    if (getApps().length === 0)
      initializeApp({ projectId: 'demo-rv-trip-planner' })
    const adminDb = getFirestore()

    const tripId = await createTripWithPlan(page)
    // Exactly what AddCorridorStopForm used to write: a name, a position,
    // the traveller's own words, and no country.
    await adminDb
      .collection('trips')
      .doc(tripId)
      .collection('corridorStops')
      .add({
        name: 'Ciclopista del Garda',
        lat: 45.88,
        lng: 10.84,
        status: 'locked',
        origin: 'traveler',
        why: 'Cool bicycle path!',
        linkedDayIds: [],
      })

    await page.getByTestId('nav-map').click()
    const banner = page.getByTestId('days-out-of-step-banner')
    await expect(banner).toBeVisible({ timeout: 10_000 })

    // It says why, instead of offering a button that provably will not work.
    // (Maps is unreachable in this sandbox, so the lookup that repairs this
    // never lands — which is exactly the state the message describes.)
    await expect(page.getByTestId('undatable-stops')).toContainText(
      'country looked up',
    )
    await expect(page.getByTestId('days-out-of-step-rebuild')).toHaveCount(0)
  })

  // And once the country is there, it is an ordinary stop: packed, dated,
  // and the banner has nothing left to report.
  test('joins the day list as soon as it has one', async ({ page }) => {
    const { getFirestore } = await import('firebase-admin/firestore')
    const { getApps, initializeApp } = await import('firebase-admin/app')
    process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:8080'
    if (getApps().length === 0)
      initializeApp({ projectId: 'demo-rv-trip-planner' })
    const adminDb = getFirestore()

    const tripId = await createTripWithPlan(page)
    await markDaysUnresearched(adminDb, tripId)
    const stopRef = await adminDb
      .collection('trips')
      .doc(tripId)
      .collection('corridorStops')
      .add({
        name: 'Ciclopista del Garda',
        lat: 45.88,
        lng: 10.84,
        status: 'locked',
        origin: 'traveler',
        linkedDayIds: [],
      })

    await page.getByTestId('nav-map').click()
    await expect(page.getByTestId('undatable-stops')).toBeVisible({
      timeout: 10_000,
    })

    // What the geocode would have written.
    await stopRef.update({ country: 'IT' })

    await expect(page.getByTestId('day-strip')).toContainText('Ciclopista', {
      timeout: 20_000,
    })
    await expect(page.getByTestId('days-out-of-step-banner')).toHaveCount(0)
  })
})
