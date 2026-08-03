import { expect, test } from './fixtures.js'
import { evaluateWithRetry } from './helpers/seedFixturePlan.js'
import { signIn } from './helpers/signIn.js'

test('two devices stay in sync in real time, and offline reload still shows cached data', async ({
  browser,
}) => {
  const contextA = await browser.newContext()
  const contextB = await browser.newContext()
  const pageA = await contextA.newPage()
  const pageB = await contextB.newPage()

  await signIn(pageA)
  await pageA.getByTestId('trip-name-input').waitFor()
  await evaluateWithRetry(pageA, () => navigator.serviceWorker.ready)
  const shareCodeText = await pageA.getByTestId('share-code').textContent()
  const code = shareCodeText?.replace('Share code:', '').trim()
  expect(code).toBeTruthy()

  await signIn(pageB, { path: `/?join=${code}` })
  await pageB.getByTestId('trip-name-input').waitFor()

  const inputA = pageA.getByTestId('trip-name-input')
  await inputA.fill('Oslo to Rome Adventure')
  await pageA.keyboard.press('Tab')
  await expect(inputA).toHaveValue('Oslo to Rome Adventure')

  await expect(pageB.getByTestId('trip-name-input')).toHaveValue(
    'Oslo to Rome Adventure',
    { timeout: 3000 },
  )

  await contextA.setOffline(true)
  await pageA.reload()
  await expect(pageA.getByTestId('trip-name-input')).toHaveValue(
    'Oslo to Rome Adventure',
    { timeout: 5000 },
  )

  await contextA.close()
  await contextB.close()
})
