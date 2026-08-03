import type { Page } from '@playwright/test'
import { getApps, initializeApp } from 'firebase-admin/app'
import { getFirestore } from 'firebase-admin/firestore'

process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:8080'
const PROJECT_ID = 'demo-rv-trip-planner'
if (getApps().length === 0) initializeApp({ projectId: PROJECT_ID })
const adminDb = getFirestore()

const ALLOWLIST_DOC = adminDb.collection('config').doc('allowlist')

let counter = 0

/**
 * A throwaway address for one test.
 *
 * Per-test rather than per-suite because the Auth emulator keys accounts by
 * email: the same address always resolves to the same uid, and trips now
 * hang off the account (useTripSession reuses the most recent one when
 * localStorage is empty). Sharing an address across specs would therefore
 * hand test N+1 the trip test N created, and every "a new visitor gets a
 * fresh trip" assertion in the suite would quietly stop meaning anything.
 *
 * The pid is in there because Playwright may run spec files across several
 * worker processes, each with its own copy of this module's counter.
 */
export function uniqueTestEmail(): string {
  counter += 1
  return `e2e-${process.pid}-${Date.now().toString(36)}-${counter}@example.com`
}

/**
 * Adds one address to config/allowlist — the same hand-maintained document
 * the real deployment uses, read by loadAllowedEmails on every claimAccess.
 *
 * A transaction rather than a plain write: the document is a single
 * comma-separated string shared by every test, so two workers granting
 * access at the same moment would otherwise lose one of the two additions
 * and deny a test that did everything right.
 */
export async function grantAccessTo(email: string): Promise<void> {
  const wanted = email.trim().toLowerCase()
  await adminDb.runTransaction(async (tx) => {
    const snap = await tx.get(ALLOWLIST_DOC)
    const raw = snap.data()?.emails
    const emails = (typeof raw === 'string' ? raw : '')
      .split(',')
      .map((entry) => entry.trim().toLowerCase())
      .filter((entry) => entry !== '')
    if (emails.includes(wanted)) return
    emails.push(wanted)
    tx.set(ALLOWLIST_DOC, { emails: emails.join(',') }, { merge: true })
  })
}

/**
 * Signs in as `email` without asserting anything about the outcome — the
 * account may or may not be on the allowlist, which is the point for the
 * denied-access cases.
 *
 * Waits for the gate's sign-in button first, which doubles as proof that an
 * unauthenticated visit really does stop here: if the app ever mounted
 * without access again, every spec in the suite would fail on this line
 * rather than sailing past a hole in the gate.
 */
export async function signInAs(
  page: Page,
  email: string,
  path = '/',
): Promise<void> {
  await page.goto(path)
  await page.getByTestId('access-sign-in').waitFor()
  // Retried for the same reason evaluateWithRetry exists: a page-load
  // reload landing between the locator resolving and the call destroys the
  // execution context, and that is not a test failure.
  let lastError: unknown
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      await page.waitForFunction(() => '__e2eSignIn' in window)
      await page.evaluate(
        (address) =>
          (
            window as unknown as { __e2eSignIn: (email: string) => Promise<void> }
          ).__e2eSignIn(address),
        email,
      )
      return
    } catch (error) {
      lastError = error
      await page.waitForTimeout(200)
    }
  }
  throw lastError
}

/**
 * The suite's replacement for a bare `page.goto('/')`: puts the browser in
 * front of a signed-in, allowlisted account with the app actually mounted.
 *
 * `path` is for the routes that have to be entered signed-in from the very
 * first load — `/?join=<code>`, which useTripSession reads once on mount,
 * so arriving there after a sign-in navigation would be too late.
 *
 * Returns the address it used so a spec that needs a second browser context
 * on the *same* account (a second device, rather than a second person) can
 * pass it back in.
 */
export async function signIn(
  page: Page,
  options: { email?: string; path?: string } = {},
): Promise<string> {
  const address = options.email ?? uniqueTestEmail()
  await grantAccessTo(address)
  await signInAs(page, address, options.path)
  await page.getByTestId('access-gate').waitFor({ state: 'detached' })
  return address
}
