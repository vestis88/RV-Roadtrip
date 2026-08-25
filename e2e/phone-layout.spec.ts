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

    // Everything ahead of you.
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
