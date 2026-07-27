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
  await page.goto('/')
  await page.getByTestId('share-menu-toggle').waitFor()
  await expect(page.getByTestId('copy-share-link')).not.toBeVisible()

  await page.getByTestId('share-menu-toggle').click()
  await expect(page.getByTestId('copy-share-link')).toBeVisible()
})
