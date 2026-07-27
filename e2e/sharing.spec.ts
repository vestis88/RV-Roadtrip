import { expect, test } from './fixtures.js'

test('joining via the manual code input reaches the same trip as the URL param path', async ({
  browser,
}) => {
  const contextA = await browser.newContext()
  const contextB = await browser.newContext()
  const pageA = await contextA.newPage()
  const pageB = await contextB.newPage()

  await pageA.goto('/')
  await pageA.getByTestId('trip-name-input').waitFor()
  const shareCodeText = await pageA.getByTestId('share-code').textContent()
  const code = shareCodeText?.replace('Share code:', '').trim()
  expect(code).toBeTruthy()

  await pageB.goto('/')
  await pageB.getByTestId('join-code-input').waitFor()
  await pageB.getByTestId('join-code-input').fill(code!)
  await pageB.getByTestId('join-code-submit').click()

  await pageB.getByTestId('trip-name-input').waitFor()
  await expect(pageB.getByTestId('share-code')).toHaveText(`Share code: ${code}`)

  await contextA.close()
  await contextB.close()
})

test('copy-link button is present next to the share code', async ({ page }) => {
  await page.goto('/')
  await page.getByTestId('share-code').waitFor()
  await expect(page.getByTestId('copy-share-link')).toBeVisible()
})
