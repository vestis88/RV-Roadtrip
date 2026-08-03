import type { Browser, Page } from '@playwright/test'
import { expect, test } from './fixtures.js'
import { createTripWithPlan, seedDiaryEntry } from './helpers/seedFixturePlan.js'

/** Creates the owner's trip, then hands back the view-only link they'd send. */
async function shareLinkFor(page: Page): Promise<string> {
  const tripId = await createTripWithPlan(page)
  await seedDiaryEntry(tripId, '2026-07-10', 'Kids loved the Viking exhibit.')

  await page.goto('/')
  await page.getByTestId('share-menu-toggle').click()
  await page.getByTestId('create-view-link').click()
  const link = await page.getByTestId('view-only-link').textContent()
  expect(link).toBeTruthy()
  return link!
}

/**
 * A genuinely fresh browser context: no localStorage, no IndexedDB, nothing
 * carried over from the owner's session. This is the relative on their own
 * laptop, and the only thing they have is the URL.
 */
async function openAsGuest(browser: Browser, link: string) {
  const context = await browser.newContext()
  const guest = await context.newPage()
  const requestedUrls: string[] = []
  guest.on('request', (request) => requestedUrls.push(request.url()))
  await guest.goto(link)
  return { context, guest, requestedUrls }
}

test('a relative opens the view-only link with no account and sees the plan and diary', async ({
  page,
  browser,
}) => {
  const link = await shareLinkFor(page)
  const { context, guest, requestedUrls } = await openAsGuest(browser, link)

  await expect(guest.getByTestId('shared-trip-name')).toBeVisible()
  await expect(guest.getByTestId('shared-day')).toHaveCount(3)
  await expect(guest.getByTestId('shared-day-heading').first()).toHaveText(
    'Day 1 — 2026-07-10',
  )
  await expect(
    guest.getByText('Easy first day north along the Mjøsa lake.'),
  ).toBeVisible()
  await expect(guest.getByText('Maihaugen Open-Air Museum').first()).toBeVisible()
  await expect(guest.getByTestId('shared-route-stop').first()).toBeVisible()
  await expect(guest.getByTestId('shared-diary-note')).toHaveText(
    'Kids loved the Viking exhibit.',
  )
  // The map is part of what family are here for — following where the
  // travelers are, not reading a list of place names. Google Maps JS is
  // network-blocked in this sandbox (the same limitation the in-app map
  // specs carry), so this asserts the map is mounted and sized, which is
  // what the app controls; the tiles inside it are Google's.
  await expect(guest.getByTestId('shared-map')).toBeVisible()

  // Nothing the guest can press, type into, or navigate the app with. The
  // in-app screens are full of these, so reusing an editable component by
  // mistake fails right here. It holds with the map on the page because the
  // map runs with disableDefaultUI — no fullscreen, no Street View pegman,
  // nothing that leads off this page.
  await expect(guest.locator('button')).toHaveCount(0)
  await expect(guest.locator('input, textarea, select')).toHaveCount(0)
  await expect(guest.getByTestId('share-menu')).toHaveCount(0)
  await expect(guest.getByTestId('nav-setup')).toHaveCount(0)

  // "No sign-in" as an observable fact rather than a claim about the code:
  // the page never talked to the auth emulator (no anonymous sign-up) and
  // never opened a Firestore channel — everything it shows came from the
  // one endpoint that resolves the token server-side.
  expect(requestedUrls.filter((url) => url.includes('identitytoolkit'))).toEqual(
    [],
  )
  expect(
    requestedUrls.filter((url) => url.includes('google.firestore.v1.Firestore')),
  ).toEqual([])
  expect(
    requestedUrls.some((url) => url.includes('viewSharedTrip')),
  ).toBe(true)

  await context.close()
})

test('a revoked link stops working', async ({ page, browser }) => {
  const link = await shareLinkFor(page)

  await page.getByTestId('revoke-view-link').click()
  await expect(page.getByTestId('create-view-link')).toBeVisible()

  const { context, guest } = await openAsGuest(browser, link)
  await expect(guest.getByTestId('shared-trip-missing')).toBeVisible()
  await expect(guest.getByTestId('shared-trip-view')).toHaveCount(0)

  await context.close()
})

/**
 * The reason this is a live endpoint rather than a published snapshot: a
 * relative leaves the page open, the travelers log something that evening,
 * and it appears without anybody reloading or re-sending the link.
 */
test('the open page picks up new diary entries on its own', async ({
  page,
  browser,
}) => {
  test.setTimeout(120_000)

  const tripId = await createTripWithPlan(page)
  await page.goto('/')
  await page.getByTestId('share-menu-toggle').click()
  await page.getByTestId('create-view-link').click()
  const link = await page.getByTestId('view-only-link').textContent()

  const { context, guest } = await openAsGuest(browser, link!)
  await expect(guest.getByTestId('shared-diary-empty')).toBeVisible()

  await seedDiaryEntry(tripId, '2026-07-11', 'Rafting was the best bit.')

  // Longer than the page's own poll interval, with no interaction at all in
  // between — not even a click, which would otherwise be doing the work.
  await expect(guest.getByTestId('shared-diary-note')).toHaveText(
    'Rafting was the best bit.',
    { timeout: 60_000 },
  )

  await context.close()
})
