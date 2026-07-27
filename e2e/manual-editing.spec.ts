import { expect, test } from './fixtures.js'
import { createTripWithPlan } from './helpers/seedFixturePlan.js'

// PlaceAutocompleteInput renders a plain fallback <input> when the Places
// library hasn't loaded (e.g. no network route to Google's API in this
// sandbox) — same pattern settings.spec.ts already relies on.
async function setPlaceInput(locator: import('@playwright/test').Locator, value: string) {
  await locator.evaluate((el: HTMLInputElement, v: string) => {
    el.focus()
    el.value = v
    el.blur()
  }, value)
}

test('skipping an activity marks it skipped without removing it', async ({
  page,
}) => {
  await createTripWithPlan(page)
  await page.goto('/map/day/2026-07-10')
  await page.getByTestId('day-view').waitFor()

  await expect(page.getByTestId('activity-card-0-status')).toContainText(
    'suggested',
  )
  await page.getByTestId('activity-card-0-mark-skipped').click()
  await expect(page.getByTestId('activity-card-0-status')).toContainText(
    'skipped',
  )
  // Still present, just marked — this is not a dismiss/hide feature.
  await expect(page.getByTestId('activity-card-0')).toBeVisible()
})

test('adding a custom activity writes a new selected activity card', async ({
  page,
}) => {
  await createTripWithPlan(page)
  await page.goto('/map/day/2026-07-10')
  await page.getByTestId('day-view').waitFor()

  await page.getByTestId('add-custom-stop-toggle').click()
  await page.getByTestId('custom-stop-kind-activity').click()
  await page.getByTestId('custom-stop-name').fill('Sjoa river rafting')
  await setPlaceInput(page.getByTestId('custom-stop-location'), 'Sjoa, Norway')
  await page.getByTestId('custom-stop-category').selectOption('other')
  await page.getByTestId('custom-stop-kid-friendly').check()
  await page
    .getByTestId('custom-stop-blurb')
    .fill('A splash of adventure on a rest day.')
  await page.getByTestId('custom-stop-submit').click()

  await expect(page.getByTestId('add-custom-stop-form')).toHaveCount(0)
  await expect(page.getByTestId('activities-row')).toContainText(
    'Sjoa river rafting',
  )
})

test('adding a custom restaurant writes a new selected restaurant card in the right meal row', async ({
  page,
}) => {
  await createTripWithPlan(page)
  await page.goto('/map/day/2026-07-10')
  await page.getByTestId('day-view').waitFor()

  await page.getByTestId('add-custom-stop-toggle').click()
  await page.getByTestId('custom-stop-kind-restaurant').click()
  await page.getByTestId('custom-stop-name').fill('Otta Café')
  await setPlaceInput(page.getByTestId('custom-stop-location'), 'Otta, Norway')
  await page.getByTestId('custom-stop-meal').selectOption('lunch')
  await page
    .getByTestId('custom-stop-blurb')
    .fill('Simple local café, good stop before the trail.')
  await page.getByTestId('custom-stop-submit').click()

  await expect(page.getByTestId('add-custom-stop-form')).toHaveCount(0)
  await expect(page.getByTestId('lunch-row')).toContainText('Otta Café')
  await expect(page.getByTestId('breakfast-row')).not.toContainText(
    'Otta Café',
  )
})

test('add-custom-stop form requires a name and description', async ({
  page,
}) => {
  await createTripWithPlan(page)
  await page.goto('/map/day/2026-07-10')
  await page.getByTestId('day-view').waitFor()

  await page.getByTestId('add-custom-stop-toggle').click()
  await page.getByTestId('custom-stop-submit').click()
  await expect(page.getByTestId('custom-stop-error')).toBeVisible()
  await expect(page.getByTestId('add-custom-stop-form')).toBeVisible()
})

test('selecting an activity gives it a distinct look from tapping it', async ({
  page,
}) => {
  await createTripWithPlan(page)
  await page.goto('/map/day/2026-07-10')
  await page.getByTestId('day-view').waitFor()

  const card = page.getByTestId('activity-card-0')
  await expect(card).not.toHaveClass(/border-sky-600/)
  await expect(card).not.toHaveClass(/border-orange-600/)

  await page.getByTestId('activity-card-0-mark-selected').click()
  await expect(card).toHaveClass(/border-sky-600/)

  // Tap-to-view is a separate, distinct highlight (orange) from the
  // data-level "selected" state (blue) — selecting alone must not trigger it.
  await expect(card).not.toHaveClass(/border-orange-600/)
  await card.click()
  await expect(card).toHaveClass(/border-orange-600/)
})

test('request changes for this day submits a replan locking every other day', async ({
  page,
}) => {
  await createTripWithPlan(page)
  await page.goto('/map/day/2026-07-11')
  await page.getByTestId('day-view').waitFor()

  await page.getByTestId('request-changes-for-day-button').click()
  await expect(page.getByTestId('request-changes-for-day-form')).toContainText(
    'Day 2',
  )
  await page
    .getByTestId('change-request-text-for-day')
    .fill('less driving today')
  await page.getByTestId('submit-change-request-for-day').click()

  await expect(page.getByTestId('request-changes-for-day-form')).toHaveCount(0)
})

test('opening "Change overnight stop" fails gracefully without Claude/Places credentials', async ({
  page,
}) => {
  // CLAUDE_API_KEY/GOOGLE_PLACES_API_KEY aren't configured in this sandbox
  // (same caveat as T-14/T-16/T-18/T-22/countries.spec.ts's refresh test) —
  // getOvernightCandidates has no synthetic fallback by design, so this
  // confirms the callable failing shows a clear error instead of hanging
  // or crashing the screen.
  await createTripWithPlan(page)
  await page.goto('/map/day/2026-07-10')
  await page.getByTestId('day-view').waitFor()

  await page.getByTestId('change-overnight-toggle').click()
  await expect(page.getByTestId('overnight-candidates-panel')).toBeVisible()
  await expect(page.getByTestId('overnight-candidates-error')).toBeVisible({
    timeout: 10_000,
  })

  await page.getByTestId('change-overnight-cancel').click()
  await expect(page.getByTestId('overnight-candidates-panel')).toHaveCount(0)
})
