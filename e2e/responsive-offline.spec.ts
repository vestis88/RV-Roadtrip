import { expect, test } from './fixtures.js'
import {
  createTripWithPlan,
  evaluateWithRetry,
} from './helpers/seedFixturePlan.js'

const VIEWPORTS = {
  phone: { width: 375, height: 812 },
  ipadPortrait: { width: 820, height: 1180 },
  ipadLandscape: { width: 1180, height: 820 },
}

const MIN_TAP_TARGET_PX = 44

for (const [name, viewport] of Object.entries(VIEWPORTS)) {
  test(`no horizontal scroll on any screen at ${name}`, async ({ page }) => {
    await page.setViewportSize(viewport)
    await createTripWithPlan(page)

    for (const testId of ['nav-setup', 'nav-map', 'nav-diary', 'nav-countries']) {
      await page.getByTestId(testId).click()
      const overflow = await evaluateWithRetry(
        page,
        () => document.documentElement.scrollWidth - window.innerWidth,
      )
      expect(overflow, `horizontal overflow on ${testId} at ${name}`).toBeLessThanOrEqual(
        1,
      )
    }
  })
}

test('primary nav links and the request-changes button meet the 44px tap target minimum', async ({
  page,
}) => {
  await page.setViewportSize(VIEWPORTS.phone)
  await createTripWithPlan(page)

  for (const testId of ['nav-setup', 'nav-map', 'nav-diary', 'nav-countries']) {
    const box = await page.getByTestId(testId).boundingBox()
    expect(box?.height ?? 0, `${testId} height`).toBeGreaterThanOrEqual(
      MIN_TAP_TARGET_PX,
    )
  }

  await page.getByTestId('nav-map').click()
  const requestChangesBox = await page
    .getByTestId('request-changes-button')
    .boundingBox()
  expect(requestChangesBox?.height ?? 0).toBeGreaterThanOrEqual(
    MIN_TAP_TARGET_PX,
  )
})

test('map screen shows an offline banner and keeps cached header data when offline', async ({
  page,
  context,
}) => {
  await createTripWithPlan(page)
  await evaluateWithRetry(page, () => navigator.serviceWorker.ready)
  await page.getByTestId('nav-map').click()
  await page.getByTestId('map-header').waitFor()
  await expect(page.getByTestId('header-day-count')).toHaveText('3 days')
  await expect(page.getByTestId('offline-banner')).toHaveCount(0)

  await context.setOffline(true)
  await page.reload()

  await expect(page.getByTestId('offline-banner')).toBeVisible({
    timeout: 5_000,
  })
  // Firestore's persistent local cache keeps last-synced day data readable
  // offline — the header numbers must still be there, not blanked out.
  await expect(page.getByTestId('header-day-count')).toHaveText('3 days')

  await context.setOffline(false)
})
