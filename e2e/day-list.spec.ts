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

/**
 * Reported 2026-08-24: "The list of day plans on top does not seem to update
 * dynamically… I've removed stops previously locked in, but the items are
 * still in the day list. My intention was to not have to interact in the
 * same way with the day view."
 */

test('the day list can be rebuilt from the board without going through the day view', async ({
  page,
}) => {
  const tripId = await createTripWithPlan(page)
  // Detail on a day is what freezes the automatic writer — correct, since
  // that detail was paid for, and the reason nothing recomputed the strip.
  const dayId = await getDayIdByDate(tripId, '2026-07-10')
  await adminDb
    .collection('trips')
    .doc(tripId)
    .collection('days')
    .doc(dayId)
    .update({ detailStatus: 'ready' })

  // One kept stop the fixture's generated days know nothing about.
  await adminDb
    .collection('trips')
    .doc(tripId)
    .collection('corridorStops')
    .add({
      name: 'Lom',
      lat: 61.84,
      lng: 8.57,
      country: 'NO',
      status: 'locked',
      linkedDayIds: [],
      priority: 'must-see',
      rank: 0,
    })

  await page.getByTestId('nav-map').click()
  await page.getByTestId('map-header').waitFor()
  await page.getByTestId('day-strip').waitFor()

  await page.getByTestId('rebuild-days-button').click()
  await expect(page.getByTestId('rebuild-days-panel')).toContainText(
    'discarded',
  )
  await page.getByTestId('rebuild-days-confirm').click()
  await expect(page.getByTestId('rebuild-days-panel')).toHaveCount(0)

  // The strip now describes the kept stop, which it could not before.
  await expect(page.getByTestId('day-strip')).toContainText('Lom', {
    timeout: 10_000,
  })
})

test('days orphaned by a removed stop are offered for cleanup, and go', async ({
  page,
}) => {
  const tripId = await createTripWithPlan(page)

  // Exactly the state an older build could leave behind: a stop out of the
  // route whose linkedDayIds still claim a day. That mismatch is also what
  // makes reconcileCorridor throw, so it is not cosmetic.
  const stops = await adminDb
    .collection('trips')
    .doc(tripId)
    .collection('corridorStops')
    .get()
  const victim = stops.docs[0]
  const orphanedDayIds = (victim.data().linkedDayIds ?? []) as string[]
  expect(orphanedDayIds.length).toBeGreaterThan(0)
  await victim.ref.update({ status: 'rejected' })

  await page.getByTestId('nav-map').click()
  await page.getByTestId('map-header').waitFor()

  const banner = page.getByTestId('stale-days-banner')
  await expect(banner).toBeVisible({ timeout: 10_000 })
  await expect(banner).toContainText('removed from the route')

  await page.getByTestId('tidy-stale-days').click()

  // Polled against the SERVER rather than asserted against the banner. The
  // Firestore web SDK applies a batch to its local cache before the server
  // acknowledges it, so the banner vanishes the instant the delete is
  // queued — asserting on that and then reading through the admin SDK races
  // the commit, and tears the page down mid-write when it loses.
  await expect
    .poll(
      async () => {
        const snap = await adminDb
          .collection('trips')
          .doc(tripId)
          .collection('days')
          .get()
        return snap.docs.map((doc) => doc.id)
      },
      { timeout: 15_000 },
    )
    .not.toContain(orphanedDayIds[0])
  await expect(page.getByTestId('stale-days-banner')).toHaveCount(0)

  // Really gone, not merely hidden.
  for (const dayId of orphanedDayIds) {
    const snap = await adminDb
      .collection('trips')
      .doc(tripId)
      .collection('days')
      .doc(dayId)
      .get()
    expect(snap.exists).toBe(false)
  }
  // And the stale link is cleared, which is what keeps "Edit route" usable.
  const after = await victim.ref.get()
  expect(after.data()?.linkedDayIds).toEqual([])
})
