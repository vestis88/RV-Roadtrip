import { expect, test } from './fixtures.js'
import { signIn } from './helpers/signIn.js'

test('joining via the manual code input reaches the same trip as the URL param path', async ({
  browser,
}) => {
  const contextA = await browser.newContext()
  const contextB = await browser.newContext()
  const pageA = await contextA.newPage()
  const pageB = await contextB.newPage()

  // Two different allowlisted accounts, which is what sharing a trip
  // actually is now: both travelers are past the gate, and the share code
  // is what decides which of them may see this particular trip.
  await signIn(pageA)
  await pageA.getByTestId('trip-name-input').waitFor()
  const shareCodeText = await pageA.getByTestId('share-code').textContent()
  const code = shareCodeText?.replace('Share code:', '').trim()
  expect(code).toBeTruthy()

  await signIn(pageB)
  await pageB.getByTestId('share-menu-toggle').click()
  await pageB.getByTestId('join-code-input').fill(code!)
  await pageB.getByTestId('join-code-submit').click()

  await pageB.getByTestId('trip-name-input').waitFor()
  await pageB.getByTestId('share-menu-toggle').click()
  await expect(pageB.getByTestId('share-code')).toHaveText(`Share code: ${code}`)

  await contextA.close()
  await contextB.close()
})

test('copy-link button is present next to the share code, behind the collapsed share menu', async ({
  page,
}) => {
  await signIn(page)
  await page.getByTestId('share-menu-toggle').waitFor()
  await expect(page.getByTestId('copy-share-link')).not.toBeVisible()

  await page.getByTestId('share-menu-toggle').click()
  await expect(page.getByTestId('copy-share-link')).toBeVisible()
})

// Reaching the app at all now means signing in with Google, so the backup
// menu's "not linked yet" branch is unreachable from a normal session — the
// only sessions that can still see it are the anonymous ones that predate
// the access gate, which no new visitor can create. What it must show
// everyone else is the address their trips are attached to, since that is
// now what tells a traveler which account to sign into on a second device.
test('account backup menu names the account the trips are attached to', async ({
  page,
}) => {
  const email = await signIn(page)
  await page.getByTestId('account-backup-toggle').waitFor()
  await expect(page.getByTestId('account-backup-linked')).not.toBeVisible()

  await page.getByTestId('account-backup-toggle').click()
  await expect(page.getByTestId('account-backup-linked')).toHaveText(
    `Backed up with ${email}`,
  )
  await expect(page.getByTestId('account-backup-link')).not.toBeVisible()
})
