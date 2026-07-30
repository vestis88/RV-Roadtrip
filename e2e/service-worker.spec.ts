import { expect, test } from './fixtures.js'
import { evaluateWithRetry } from './helpers/seedFixturePlan.js'

// Regression test for src/main.tsx's controllerchange reload: it used to
// fire (and reload the page) on the very first-ever visit, not just a
// genuine cross-deploy update, because clientsClaim() fires
// 'controllerchange' the first time an uncontrolled page gets claimed too.
// This also happened to be the root cause of a long-running e2e flakiness
// pattern ("Execution context was destroyed, most likely because of a
// navigation") — the reload landing in the gap between a waitFor() and the
// very next page.evaluate() under enough contention.
test('a first-ever visit does not reload itself once the service worker claims it', async ({
  page,
}) => {
  let loadCount = 0
  page.on('load', () => {
    loadCount++
  })

  await page.goto('/')
  await page.getByTestId('trip-name-input').waitFor()
  expect(loadCount).toBe(1)

  // Wait for the exact event that used to trigger the reload — the service
  // worker actually taking control of this (previously uncontrolled) page —
  // so a still-present bug would have every chance to fire within the
  // timeout, not just get missed by an arbitrary fixed wait.
  await evaluateWithRetry(page, () => navigator.serviceWorker.ready)
  await expect
    .poll(
      () => page.evaluate(() => navigator.serviceWorker.controller != null),
      { timeout: 10_000 },
    )
    .toBe(true)

  expect(loadCount).toBe(1)
})
