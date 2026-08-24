import { expect, test } from './fixtures.js'
import {
  evaluateWithRetry,
  getDayIdByDate,
  seedFixturePlan,
} from './helpers/seedFixturePlan.js'
import { signIn } from './helpers/signIn.js'

test('marking cards done with notes logs them to the diary, synced live to a second device', async ({
  browser,
}) => {
  const contextA = await browser.newContext()
  const contextB = await browser.newContext()
  const pageA = await contextA.newPage()
  const pageB = await contextB.newPage()

  await signIn(pageA)
  await pageA.getByTestId('trip-name-input').waitFor()
  const shareCodeText = await pageA.getByTestId('share-code').textContent()
  const code = shareCodeText?.replace('Share code:', '').trim()
  expect(code).toBeTruthy()

  const tripId = await evaluateWithRetry(pageA, () => localStorage.getItem('tripId'))
  if (!tripId) throw new Error('tripId missing from localStorage')
  await seedFixturePlan(tripId)

  await signIn(pageB, { path: `/?join=${code}` })
  await pageB.getByTestId('nav-diary').waitFor()

  const dayId = await getDayIdByDate(tripId, '2026-07-10')
  await pageA.goto(`/map/day/${dayId}`)
  await pageA.getByTestId('day-view').waitFor()

  await pageA.getByTestId('activity-card-0-mark-done').click()
  await pageA
    .getByTestId('activity-card-0-note-input')
    .fill('Kids loved the open-air museum!')
  await pageA.getByTestId('activity-card-0-confirm-done').click()
  await expect(pageA.getByTestId('activity-card-0-status')).toContainText(
    'done',
  )

  await pageA.getByTestId('dinner-card-0-mark-done').click()
  await pageA.getByTestId('dinner-card-0-note-input').fill('Great local food.')
  await pageA.getByTestId('dinner-card-0-confirm-done').click()
  await expect(pageA.getByTestId('dinner-card-0-status')).toContainText('done')

  // Second device: navigate to the Diary and see both entries appear live.
  await pageB.getByTestId('nav-diary').click()
  await expect(pageB.getByTestId('diary-list')).toBeVisible()
  await expect(pageB.getByTestId('diary-entry')).toHaveCount(2, {
    timeout: 5_000,
  })
  await expect(
    pageB.getByTestId('diary-entry-note').filter({
      hasText: 'Kids loved the open-air museum!',
    }),
  ).toBeVisible()
  await expect(
    pageB.getByTestId('diary-entry-note').filter({
      hasText: 'Great local food.',
    }),
  ).toBeVisible()

  await contextA.close()
  await contextB.close()
})

/**
 * Asked 2026-08-24: "How do I add to diary?"
 *
 * The test above covers the older path — a place inside a day. This one
 * covers the path from the board, which is the one the traveler was looking
 * at when they asked, and which had shipped without the editable moment the
 * original request specified ("defaulting to 'now' but possible to change if
 * we are lazy with marking done").
 */
test('marking a stop done from the board files it in the diary on the day given', async ({
  page,
}) => {
  const { getFirestore } = await import('firebase-admin/firestore')
  const { getApps, initializeApp } = await import('firebase-admin/app')
  process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:8080'
  if (getApps().length === 0)
    initializeApp({ projectId: 'demo-rv-trip-planner' })
  const adminDb = getFirestore()

  await signIn(page)
  await page.getByTestId('trip-name-input').waitFor()
  const tripId = await evaluateWithRetry(page, () =>
    localStorage.getItem('tripId'),
  )
  if (!tripId) throw new Error('tripId missing from localStorage')

  await adminDb
    .collection('trips')
    .doc(tripId)
    .update({
      'settings.startPoint': { name: 'Munich, Germany', lat: 48.14, lng: 11.58 },
      'settings.endPoint': { name: 'Innsbruck, Austria', lat: 47.27, lng: 11.4 },
    })
  const stop = await adminDb
    .collection('trips')
    .doc(tripId)
    .collection('corridorStops')
    .add({
      name: 'Partnach Gorge',
      lat: 47.47,
      lng: 11.12,
      country: 'DE',
      why: 'A gorge walk.',
      status: 'locked',
      linkedDayIds: [],
      priority: 'must-see',
      rank: 0,
    })

  await page.getByTestId('nav-map').click()
  await page.getByTestId('explore-map-screen').waitFor()

  await page.getByTestId(`explore-candidate-mark-done-${stop.id}`).click()
  // Backdated on purpose — the whole point of the field.
  await page
    .getByTestId(`explore-candidate-done-when-${stop.id}`)
    .fill('2026-07-11T15:20')
  await page
    .getByTestId(`explore-candidate-done-note-${stop.id}`)
    .fill('Soaked by the waterfall.')
  await page.getByTestId(`explore-candidate-done-save-${stop.id}`).click()

  await expect(
    page.getByTestId(`explore-candidate-done-at-${stop.id}`),
  ).toBeVisible()

  await page.getByTestId('nav-diary').click()
  await expect(page.getByTestId('diary-list')).toBeVisible()
  const entry = page.getByTestId('diary-entry').filter({ hasText: 'Partnach' })
  await expect(entry).toBeVisible({ timeout: 5_000 })
  // The date given, not the date typed.
  await expect(entry).toContainText('2026-07-11')
  await expect(entry).toContainText('stop')
  await expect(
    page.getByTestId('diary-entry-note').filter({
      hasText: 'Soaked by the waterfall.',
    }),
  ).toBeVisible()
})
