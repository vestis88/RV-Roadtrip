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
