import { expect, test } from '@playwright/test'
import { createTripWithPlan } from './helpers/seedFixturePlan.js'

const VIEWPORTS = {
  phone: { width: 375, height: 812 },
  ipadPortrait: { width: 820, height: 1180 },
  ipadLandscape: { width: 1180, height: 820 },
}

for (const [name, viewport] of Object.entries(VIEWPORTS)) {
  test(`day view layout renders drive card and activity/meal rows at ${name}`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport)
    await createTripWithPlan(page)
    await page.goto('/map/day/2026-07-10')
    await page.getByTestId('day-view').waitFor()

    await expect(page.getByTestId('day-view-date')).toContainText('Day 1')
    await expect(page.getByTestId('drive-card')).toContainText('Oslo')
    await expect(page.getByTestId('activities-row')).toBeVisible()
    await expect(page.getByTestId('breakfast-row')).toBeVisible()
    await expect(page.getByTestId('lunch-row')).toBeVisible()
    await expect(page.getByTestId('dinner-row')).toBeVisible()
    await expect(page.getByTestId('activity-card-0')).toContainText(
      'Maihaugen',
    )
  })
}

test('rest day shows the no-driving banner instead of a drive card', async ({
  page,
}) => {
  await createTripWithPlan(page)
  await page.goto('/map/day/2026-07-12')
  await page.getByTestId('day-view').waitFor()
  await expect(page.getByTestId('rest-day-banner')).toContainText(
    'No driving today',
  )
  await expect(page.getByTestId('drive-card')).toHaveCount(0)
})

test('prev/next arrows and swipe cycle days without visiting the overview', async ({
  page,
}) => {
  await createTripWithPlan(page)
  await page.goto('/map/day/2026-07-10')
  await page.getByTestId('day-view').waitFor()
  await expect(page.getByTestId('prev-day')).toBeDisabled()

  await page.getByTestId('next-day').click()
  await expect(page.getByTestId('day-view-date')).toContainText('2026-07-11')
  expect(page.url()).toContain('/map/day/2026-07-11')

  // Swipe left (finger moves right-to-left) should advance to the next day,
  // exercising the same touch handler a phone user would trigger.
  const dayView = page.getByTestId('day-view')
  const box = await dayView.boundingBox()
  if (!box) throw new Error('day-view has no bounding box')
  const midY = box.y + box.height / 2
  await dayView.dispatchEvent('touchstart', {
    touches: [{ identifier: 0, clientX: box.x + box.width - 20, clientY: midY }],
  })
  await dayView.dispatchEvent('touchend', {
    changedTouches: [{ identifier: 0, clientX: box.x + 20, clientY: midY }],
  })
  await expect(page.getByTestId('day-view-date')).toContainText('2026-07-12')
  expect(page.url()).toContain('/map/day/2026-07-12')
  await expect(page.getByTestId('next-day')).toBeDisabled()
})
