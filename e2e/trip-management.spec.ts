import { getApps, initializeApp } from 'firebase-admin/app'
import { getFirestore } from 'firebase-admin/firestore'
import { expect, test } from './fixtures.js'
import { evaluateWithRetry } from './helpers/seedFixturePlan.js'

process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:8080'
const PROJECT_ID = 'demo-rv-trip-planner'
if (getApps().length === 0) initializeApp({ projectId: PROJECT_ID })
const adminDb = getFirestore()

test('the New trip button creates a fresh trip with an empty name, distinct from the one it started on', async ({
  page,
}) => {
  await page.goto('/')
  await page.getByTestId('trip-name-input').waitFor()
  await page.getByTestId('trip-name-input').fill('Norway Loop')
  await page.keyboard.press('Tab')
  await expect(page.getByTestId('trip-name-input')).toHaveValue('Norway Loop')

  const firstTripId = await evaluateWithRetry(page, () => localStorage.getItem('tripId'))
  expect(firstTripId).toBeTruthy()

  await page.getByTestId('trip-switcher-toggle').click()
  await expect(page.getByTestId('trip-switcher')).toContainText('My trips (1)')

  await page.getByTestId('new-trip-button').click()
  // Empty, not pre-filled with a placeholder like "New Trip" — ready to type
  // into immediately.
  await expect(page.getByTestId('trip-name-input')).toHaveValue('', {
    timeout: 10_000,
  })

  const secondTripId = await evaluateWithRetry(page, () => localStorage.getItem('tripId'))
  expect(secondTripId).toBeTruthy()
  expect(secondTripId).not.toBe(firstTripId)

  // The switcher panel (not the summary toggle) stayed open across the
  // click, so this reflects the post-creation state without re-toggling.
  await expect(page.getByTestId('trip-switcher')).toContainText('My trips (2)')
})

test('switching trips shows each one\'s own diary, and a new trip starts with an empty one', async ({
  page,
}) => {
  await page.goto('/')
  await page.getByTestId('trip-name-input').waitFor()
  const firstTripId = await evaluateWithRetry(page, () => localStorage.getItem('tripId'))
  if (!firstTripId) throw new Error('tripId missing from localStorage')

  await adminDb
    .collection('trips')
    .doc(firstTripId)
    .collection('log')
    .add({
      date: '2026-07-10',
      refType: 'activity',
      refPath: `trips/${firstTripId}/days/day1/activities/activity1`,
      note: 'A trip-one memory.',
      createdAt: new Date().toISOString(),
    })

  await page.getByTestId('nav-diary').click()
  await expect(page.getByTestId('diary-entry')).toHaveCount(1)
  await expect(page.getByTestId('diary-entry-note')).toContainText(
    'A trip-one memory.',
  )

  await page.getByTestId('nav-setup').click()
  await page.getByTestId('trip-switcher-toggle').click()
  await page.getByTestId('new-trip-button').click()
  // Both trips have an empty name, so waiting on the input's value proves
  // nothing here — poll localStorage itself for the actual switch instead.
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem('tripId')))
    .not.toBe(firstTripId)

  await page.getByTestId('nav-diary').click()
  await expect(page.getByTestId('diary-empty')).toBeVisible()
  await expect(page.getByTestId('diary-entry')).toHaveCount(0)

  // Switching back restores the first trip's own diary — its log entries
  // were never touched, just not the active trip for a moment.
  await page.getByTestId('nav-setup').click()
  await page.getByTestId('trip-switcher-toggle').click()
  await page.getByTestId(`trip-switcher-item-${firstTripId}`).click()
  await page.getByTestId('nav-diary').click()
  await expect(page.getByTestId('diary-entry')).toHaveCount(1)
})

test('joining a trip by share code adds it to the trip switcher without losing the original', async ({
  page,
}) => {
  await page.goto('/')
  await page.getByTestId('trip-name-input').waitFor()
  const firstTripId = await evaluateWithRetry(page, () => localStorage.getItem('tripId'))
  const shareCodeText = await page.getByTestId('share-code').textContent()
  const code = shareCodeText?.replace('Share code:', '').trim()
  expect(code).toBeTruthy()

  await page.getByTestId('trip-switcher-toggle').click()
  await page.getByTestId('new-trip-button').click()
  // Both trips have an empty name, so waiting on the input's value proves
  // nothing here — poll localStorage itself for the actual switch instead.
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem('tripId')))
    .not.toBe(firstTripId)
  const secondTripId = await evaluateWithRetry(page, () => localStorage.getItem('tripId'))

  // Re-joining the first trip by its own share code, from this second
  // trip's session, should land it in the switcher alongside the second
  // trip rather than silently replacing it.
  await page.goto(`/?join=${code}`)
  await page.getByTestId('trip-name-input').waitFor()
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem('tripId')))
    .toBe(firstTripId)

  await page.getByTestId('trip-switcher-toggle').click()
  await expect(page.getByTestId('trip-switcher')).toContainText('My trips (2)')
  await expect(
    page.getByTestId(`trip-switcher-item-${secondTripId}`),
  ).toBeVisible()

  // The ?join= param doesn't linger to re-hijack a later reload.
  expect(page.url()).not.toContain('join=')
})

test('a new trip inherits the previous trip\'s settings and notes, except start/finish points', async ({
  page,
}) => {
  await page.goto('/')
  await page.getByTestId('trip-name-input').waitFor()
  const firstTripId = await evaluateWithRetry(page, () => localStorage.getItem('tripId'))
  if (!firstTripId) throw new Error('tripId missing from localStorage')

  await adminDb
    .collection('trips')
    .doc(firstTripId)
    .update({
      'settings.interests': ['hiking', 'museums'],
      'settings.restDayFrequency': 5,
      'settings.maxDriveHoursPerDay': 6,
      'settings.startPoint': { name: 'Oslo, Norway', lat: 59.91, lng: 10.75 },
      'settings.endPoint': { name: 'Bergen, Norway', lat: 60.39, lng: 5.32 },
      'notes.freeText': 'Traveling with a dog, prefer quiet campsites.',
    })

  await page.getByTestId('trip-switcher-toggle').click()
  await page.getByTestId('new-trip-button').click()
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem('tripId')))
    .not.toBe(firstTripId)
  const secondTripId = await evaluateWithRetry(page, () => localStorage.getItem('tripId'))

  const secondTripSnap = await adminDb.collection('trips').doc(secondTripId!).get()
  const settings = secondTripSnap.data()?.settings
  expect(settings.interests).toEqual(['hiking', 'museums'])
  expect(settings.restDayFrequency).toBe(5)
  expect(settings.maxDriveHoursPerDay).toBe(6)
  expect(secondTripSnap.data()?.notes.freeText).toBe(
    'Traveling with a dog, prefer quiet campsites.',
  )
  // Origin/destination reset to the fresh trip's own blank defaults rather
  // than carrying over the previous trip's route.
  expect(settings.startPoint.name).toBe('')
  expect(settings.endPoint.name).toBe('')
})

test('deleting a trip removes it from the switcher; deleting the active trip switches away', async ({
  page,
}) => {
  await page.goto('/')
  await page.getByTestId('trip-name-input').waitFor()
  const firstTripId = await evaluateWithRetry(page, () => localStorage.getItem('tripId'))

  await page.getByTestId('trip-switcher-toggle').click()
  await page.getByTestId('new-trip-button').click()
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem('tripId')))
    .not.toBe(firstTripId)
  const secondTripId = await evaluateWithRetry(page, () => localStorage.getItem('tripId'))

  await page.getByTestId('trip-switcher-toggle').click()
  await expect(page.getByTestId('trip-switcher')).toContainText('My trips (2)')

  // Delete the non-active first trip — the switcher should just drop it.
  await page.getByTestId(`trip-delete-${firstTripId}`).click()
  await page.getByTestId(`trip-delete-confirm-${firstTripId}`).click()
  await expect(page.getByTestId('trip-switcher')).toContainText('My trips (1)')
  await expect(
    page.getByTestId(`trip-switcher-item-${firstTripId}`),
  ).toHaveCount(0)
  await expect(
    (await adminDb.collection('trips').doc(firstTripId!).get()).exists,
  ).toBe(false)

  // Delete the now-active (second) trip — must land somewhere real, not a
  // trip that no longer exists.
  await page.getByTestId(`trip-delete-${secondTripId}`).click()
  await page.getByTestId(`trip-delete-confirm-${secondTripId}`).click()
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem('tripId')))
    .not.toBe(secondTripId)
  await page.getByTestId('trip-name-input').waitFor()
})

test('a trip created before the reverse index existed still shows up in "My trips"', async ({
  page,
}) => {
  await page.goto('/')
  await page.getByTestId('trip-name-input').waitFor()
  const tripId = await evaluateWithRetry(page, () => localStorage.getItem('tripId'))
  if (!tripId) throw new Error('tripId missing from localStorage')

  // Simulate a trip whose reverse-index write never happened (an old trip
  // predating that feature): delete the index doc but leave everything
  // else — membership, the active trip itself — untouched.
  const membersSnap = await adminDb
    .collection('trips')
    .doc(tripId)
    .collection('members')
    .get()
  const memberUid = membersSnap.docs[0]?.id
  if (!memberUid) throw new Error('no member doc found on the seeded trip')
  await adminDb.collection('users').doc(memberUid).collection('trips').doc(tripId).delete()

  await page.reload()
  await page.getByTestId('trip-name-input').waitFor()
  await page.getByTestId('trip-switcher-toggle').click()
  await expect(page.getByTestId('trip-switcher')).toContainText('My trips (1)', {
    timeout: 10_000,
  })
  await expect(page.getByTestId(`trip-switcher-item-${tripId}`)).toBeVisible()
})

test('switching back to a previously-viewed trip shows its own settings again, not the other trip\'s stale ones', async ({
  page,
}) => {
  await page.goto('/')
  await page.getByTestId('trip-name-input').waitFor()
  const firstTripId = await evaluateWithRetry(page, () => localStorage.getItem('tripId'))
  if (!firstTripId) throw new Error('tripId missing from localStorage')

  await adminDb
    .collection('trips')
    .doc(firstTripId)
    .update({
      'settings.startDate': '2026-07-10',
      'settings.endDate': '2026-08-02',
      'settings.startPoint': { name: 'Oslo, Norway', lat: 59.91, lng: 10.75 },
      'settings.endPoint': { name: 'Bergen, Norway', lat: 60.39, lng: 5.32 },
    })
  await page.reload()
  await page.getByTestId('trip-name-input').waitFor()
  await expect(page.getByTestId('start-date-input')).toHaveValue('2026-07-10')
  const startPointValue = () =>
    page
      .getByTestId('start-point-input')
      .evaluate((el: HTMLInputElement) => el.value)
  expect(await startPointValue()).toBe('Oslo, Norway')

  // Switch to a brand-new trip — it inherits the first trip's dates (see
  // "a new trip inherits the previous trip's settings" above) but never its
  // start/finish points, which always reset — the reliable signal here,
  // since the first trip's own dates alone wouldn't distinguish "correctly
  // inherited" from "stale/never resynced". SettingsScreen mounted fresh
  // for this trip once already, so this step alone isn't where the bug
  // showed up.
  await page.getByTestId('trip-switcher-toggle').click()
  await page.getByTestId('new-trip-button').click()
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem('tripId')))
    .not.toBe(firstTripId)
  await expect.poll(startPointValue).toBe('')

  // Switch BACK to the first trip — now cached in the client-side trip
  // store from the earlier visit, so this doesn't remount SettingsScreen.
  // Without a resync, its local form state stayed pinned to whatever it
  // last mounted with (the second trip's blank start point), showing the
  // first trip's real destination as if it'd been erased.
  await page.getByTestId('trip-switcher-toggle').click()
  await page.getByTestId(`trip-switcher-item-${firstTripId}`).click()
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem('tripId')))
    .toBe(firstTripId)
  await expect.poll(startPointValue).toBe('Oslo, Norway')
  await expect(page.getByTestId('end-date-input')).toHaveValue('2026-08-02')
})

test('the browser tab title tracks the active trip\'s name, including across a trip switch', async ({
  page,
}) => {
  await page.goto('/')
  await page.getByTestId('trip-name-input').waitFor()
  await expect(page).toHaveTitle('RV Road Trip Planner')

  await page.getByTestId('trip-name-input').fill('Norway Loop')
  await page.keyboard.press('Tab')
  await expect(page).toHaveTitle('Norway Loop · RV Road Trip Planner')

  const firstTripId = await evaluateWithRetry(page, () => localStorage.getItem('tripId'))
  await page.getByTestId('trip-switcher-toggle').click()
  await page.getByTestId('new-trip-button').click()
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem('tripId')))
    .not.toBe(firstTripId)
  // Fresh trip, no name yet — falls back to the plain app title rather
  // than staying stuck on the previous trip's name.
  await expect(page).toHaveTitle('RV Road Trip Planner')
})
