import { expect, test } from './fixtures.js'
import {
  createTripWithPlan,
  getDayIdByDate,
} from './helpers/seedFixturePlan.js'

// The Google Maps JS API itself can't load in this sandbox (see master_plan.md's
// T-20 note — the agent proxy's egress policy blocks Google domains from the
// Playwright browser), so panning can't be observed pixel-by-pixel. Instead we
// assert the same state the pan is driven by: tapping a card marks it selected
// (aria-pressed) and surfaces a "Showing: <name>" caption tied to that place's
// coordinates — the exact input MapPanner feeds into `map.panTo()`.
test('tapping a card selects it and updates the map caption', async ({
  page,
}) => {
  const tripId = await createTripWithPlan(page)
  const dayId = await getDayIdByDate(tripId, '2026-07-10')
  await page.goto(`/map/day/${dayId}`)
  await page.getByTestId('day-view').waitFor()

  const card = page.getByTestId('activity-card-0')
  await expect(card).toHaveAttribute('aria-pressed', 'false')

  await card.click()

  await expect(card).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByTestId('map-selected-caption')).toContainText(
    'Maihaugen Open-Air Museum',
  )
})

test('Navigate link href equals the stored googleMapsUrl', async ({
  page,
}) => {
  const tripId = await createTripWithPlan(page)
  const dayId = await getDayIdByDate(tripId, '2026-07-10')
  await page.goto(`/map/day/${dayId}`)
  await page.getByTestId('day-view').waitFor()

  await expect(page.getByTestId('activity-card-0-navigate')).toHaveAttribute(
    'href',
    'https://maps.google.com/?q=Maihaugen+Open-Air+Museum',
  )
  await expect(page.getByTestId('dinner-card-0-navigate')).toHaveAttribute(
    'href',
    'https://maps.google.com/?q=Bryggerikjelleren',
  )

  // Clicking Navigate must not also select the card (it opens in a new tab).
  const card = page.getByTestId('activity-card-0')
  await page.getByTestId('activity-card-0-navigate').click({ modifiers: [] })
  await expect(card).toHaveAttribute('aria-pressed', 'false')
})
