import { expect, test } from './fixtures.js'
import { getApps, initializeApp } from 'firebase-admin/app'
import { getFirestore } from 'firebase-admin/firestore'

process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:8080'
const PROJECT_ID = 'demo-rv-trip-planner'
if (getApps().length === 0) initializeApp({ projectId: PROJECT_ID })
const adminDb = getFirestore()

async function waitFor<T>(
  fn: () => Promise<T | undefined>,
  timeoutMs = 15_000,
): Promise<T> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const result = await fn()
    if (result !== undefined) return result
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  throw new Error('Timed out waiting for condition')
}

test('hammering the Generate button creates exactly one plan request', async ({
  page,
}) => {
  await page.goto('/')
  await page.getByTestId('trip-name-input').waitFor()
  await page.getByTestId('nav-setup').click()

  const tripId = await page.evaluate(() => localStorage.getItem('tripId'))
  if (!tripId) throw new Error('tripId missing from localStorage')

  await page.getByTestId('generate-plan-button').waitFor()
  // Simulate a real rapid multi-click: dispatch several native clicks back
  // to back within a single browser tick. Driving Playwright's own
  // locator.click() concurrently doesn't model this faithfully — its
  // actionability checks for each call can race independently of the
  // page's JS thread, which isn't the failure mode this guard defends
  // against.
  await page.evaluate(() => {
    const button = document.querySelector<HTMLButtonElement>(
      '[data-testid="generate-plan-button"]',
    )
    for (let i = 0; i < 5; i++) button?.click()
  })

  // The guard's job is "exactly one request gets created," not "the plan
  // succeeds" — generatePlan's real Claude/Places pipeline has no
  // synthetic fallback and will settle on 'error' without those
  // credentials configured in this emulator, which is fine here.
  await waitFor(async () => {
    const snap = await adminDb.collection('trips').doc(tripId).get()
    const status = snap.data()?.planMeta?.status
    return status === 'ready' || status === 'error' ? status : undefined
  })

  const requestsSnap = await adminDb
    .collection('planRequests')
    .where('tripId', '==', tripId)
    .get()
  expect(requestsSnap.size).toBe(1)
})
