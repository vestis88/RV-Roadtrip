import { getApps, initializeApp } from 'firebase-admin/app'
import { getFirestore } from 'firebase-admin/firestore'
import { expect, test } from './fixtures.js'

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

  const firstTripId = await page.evaluate(() => localStorage.getItem('tripId'))
  expect(firstTripId).toBeTruthy()

  await page.getByTestId('trip-switcher-toggle').click()
  await expect(page.getByTestId('trip-switcher')).toContainText('My trips (1)')

  await page.getByTestId('new-trip-button').click()
  // Empty, not pre-filled with a placeholder like "New Trip" — ready to type
  // into immediately.
  await expect(page.getByTestId('trip-name-input')).toHaveValue('', {
    timeout: 10_000,
  })

  const secondTripId = await page.evaluate(() => localStorage.getItem('tripId'))
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
  const firstTripId = await page.evaluate(() => localStorage.getItem('tripId'))
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
  const firstTripId = await page.evaluate(() => localStorage.getItem('tripId'))
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
  const secondTripId = await page.evaluate(() => localStorage.getItem('tripId'))

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
