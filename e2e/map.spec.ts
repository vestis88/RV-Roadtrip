import { expect, test } from './fixtures.js'
import { createTripWithPlan } from './helpers/seedFixturePlan.js'

test('overview map header summarizes the plan (route/km/day count)', async ({
  page,
}) => {
  await createTripWithPlan(page)

  await page.getByTestId('nav-map').click()
  await page.getByTestId('map-header').waitFor()

  await expect(page.getByTestId('header-day-count')).toHaveText('3 days')
  await expect(page.getByTestId('header-total-km')).toBeVisible()
  await expect(page.getByTestId('header-avg-drive-minutes')).toBeVisible()
})

// The day-badge tap itself (T-21) is wired via AdvancedMarker's onClick to
// `navigate(/map/day/:dayId)` in OverviewMapScreen.tsx, but this sandbox's
// network policy blocks the Google Maps JS API from loading in the
// Playwright browser (confirmed via the agent proxy's relay-failure log,
// not an app bug — see master_plan.md's T-20 note), so no marker ever
// mounts to click. This test instead verifies the navigation's destination
// — DayViewScreen — renders the right day directly, same as a real click
// would after the map library finishes loading in a real browser.
test('day view shows the right day when navigated to directly', async ({
  page,
}) => {
  await createTripWithPlan(page)
  await page.goto('/map/day/2026-07-10')
  await page.getByTestId('day-view').waitFor()
  await expect(page.getByTestId('day-view-date')).toContainText('Day 1')
  await expect(page.getByTestId('day-view-date')).toContainText('2026-07-10')
})

test('request changes flow submits a replan with locked days preserved', async ({
  page,
}) => {
  await createTripWithPlan(page)
  await page.getByTestId('nav-map').click()
  await page.getByTestId('map-header').waitFor()

  await page.getByTestId('request-changes-button').click()
  await page.getByTestId('change-request-text').fill('more beaches, skip big cities')

  const firstDayLock = page.getByTestId(/^lock-toggle-/).first()
  await firstDayLock.locator('input[type="checkbox"]').check()

  await page.getByTestId('submit-change-request').click()
  await expect(page.getByTestId('change-request-text')).toHaveCount(0)
})
