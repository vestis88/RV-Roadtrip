import { getApps, initializeApp } from 'firebase-admin/app'
import { getAuth } from 'firebase-admin/auth'
import { getFirestore } from 'firebase-admin/firestore'
import { expect, test } from './fixtures.js'
import { evaluateWithRetry } from './helpers/seedFixturePlan.js'
import {
  grantAccessTo,
  signIn,
  signInAs,
  uniqueTestEmail,
} from './helpers/signIn.js'

process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:8080'
process.env.FIREBASE_AUTH_EMULATOR_HOST = '127.0.0.1:9099'
const PROJECT_ID = 'demo-rv-trip-planner'
if (getApps().length === 0) initializeApp({ projectId: PROJECT_ID })
const adminDb = getFirestore()

/**
 * What the gate exists to prevent, in the form it left evidence: opening the
 * app used to sign the visitor in ANONYMOUSLY and call createTrip on mount,
 * so every passer-by got an account, a trip and every Claude- and
 * Places-backed button on it.
 *
 * Nothing in the suite creates an anonymous account any more — sign-in is
 * the gate's job and it only ever offers Google — so a single one existing
 * is the regression itself, whichever spec provoked it. Counting all trips
 * instead would race the other Playwright worker, which is busy creating
 * legitimate ones.
 */
async function anonymousAccountCount(): Promise<number> {
  const { users } = await getAuth().listUsers(1000)
  return users.filter((user) => user.providerData.length === 0).length
}

/** Trips belonging to one account, which is race-free where a global count isn't. */
async function tripCountFor(email: string): Promise<number> {
  const user = await getAuth().getUserByEmail(email)
  return (
    await adminDb.collection('users').doc(user.uid).collection('trips').select().get()
  ).size
}

test('a visitor who is not signed in gets the gate, and costs nothing', async ({
  page,
}) => {
  await page.goto('/')
  await expect(page.getByTestId('access-sign-in')).toBeVisible()
  // None of the app is behind it — not the trip name, not the nav, not the
  // share code that used to be handed out on sight.
  await expect(page.getByTestId('trip-name-input')).toHaveCount(0)
  await expect(page.getByTestId('nav-setup')).toHaveCount(0)

  // Give the old mount-time sign-in and createTrip every chance to fire
  // before concluding they didn't.
  await page.waitForTimeout(2_000)
  expect(await anonymousAccountCount()).toBe(0)
  expect(await evaluateWithRetry(page, () => localStorage.getItem('tripId'))).toBeNull()
})

// The successful path through the button cannot be driven anywhere this
// suite runs — it opens Google's real OAuth flow. What matters more, and is
// testable, is what the gate does when that flow doesn't complete.
//
// The failure is forced rather than borrowed from the environment. This
// first passed by accident: the sandbox blocks apis.google.com, so the flow
// failed on its own, and on CI — where it isn't blocked — the popup opened
// instead and the test found no error to assert. Blocking the gapi loader
// explicitly makes the test mean the same thing in both places, which is
// the only version of it worth keeping.
test('a sign-in that fails says so and grants nothing', async ({ page }) => {
  let blockedTheLoader = false
  await page.route('**://apis.google.com/**', (route) => {
    blockedTheLoader = true
    return route.abort()
  })
  await page.goto('/')
  await page.getByTestId('access-sign-in').click()

  await expect(page.getByTestId('access-error')).toBeVisible()
  // Proves the interception above is what broke the flow. Without this, a
  // sandbox that happens to block apis.google.com anyway would pass this
  // test for a reason that doesn't exist on CI — which is precisely how the
  // first version of it went green here and red there.
  expect(blockedTheLoader).toBe(true)
  // Still outside. A failed attempt must not fall through to the app, and
  // must leave the button usable for a second try rather than stuck on
  // "Opening Google…".
  await expect(page.getByTestId('access-sign-in')).toBeEnabled()
  await expect(page.getByTestId('trip-name-input')).toHaveCount(0)
  expect(await anonymousAccountCount()).toBe(0)
})

test('an account that is not on the allowlist is told so, and still costs nothing', async ({
  page,
}) => {
  const stranger = uniqueTestEmail()

  // Signed in with a genuine, email-verified Google identity — the account
  // is real, it simply isn't invited. That is the case the claim exists
  // for: authentication alone must not be enough.
  await signInAs(page, stranger)

  await expect(page.getByTestId('access-denied')).toContainText(stranger)
  await expect(page.getByTestId('trip-name-input')).toHaveCount(0)
  await page.waitForTimeout(2_000)
  expect(await tripCountFor(stranger)).toBe(0)
})

test('adding the account to the allowlist lets it in on the next attempt', async ({
  page,
}) => {
  const email = uniqueTestEmail()
  await signInAs(page, email)
  await expect(page.getByTestId('access-denied')).toBeVisible()

  // The owner adds the address in the Firebase console; nothing about the
  // browser session changes. A reload is all it should take — claimAccess
  // re-reads config/allowlist and mints the claim on the spot, without the
  // traveler having to sign in again.
  await grantAccessTo(email)
  await page.reload()
  await expect(page.getByTestId('trip-name-input')).toBeVisible({ timeout: 15_000 })
})

test('signing out returns to the gate and lets go of the trip', async ({ page }) => {
  const stranger = uniqueTestEmail()
  await signInAs(page, stranger)
  await page.getByTestId('access-sign-out').click()

  await expect(page.getByTestId('access-sign-in')).toBeVisible()
  expect(await evaluateWithRetry(page, () => localStorage.getItem('tripId'))).toBeNull()
})

test('an allowlisted account reaches its own trip, and firestore lets it write', async ({
  page,
}) => {
  await signIn(page)
  await page.getByTestId('trip-name-input').waitFor()

  // A write, not just a read: firestore.rules now requires hasAccess() on
  // every path, so a claim that never reached the client would surface here
  // as a permission-denied rather than as anything the UI says out loud.
  await page.getByTestId('trip-name-input').fill('Gate check')
  await page.keyboard.press('Tab')

  const tripId = await evaluateWithRetry(page, () => localStorage.getItem('tripId'))
  if (!tripId) throw new Error('tripId missing from localStorage')
  await expect
    .poll(async () => (await adminDb.collection('trips').doc(tripId).get()).data()?.meta?.name, {
      timeout: 10_000,
    })
    .toBe('Gate check')
})
