import { expect, test } from '@playwright/test'

test('notes autosave, persist across reload, and sync live to a second device', async ({
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

  await pageB.goto(`/?join=${code}`)
  await pageB.getByTestId('notes-textarea').waitFor()

  const notesA = pageA.getByTestId('notes-textarea')
  await notesA.fill('Kid has a peanut allergy. Prefer campsites with pools.')

  // Autosave is debounced; give it time to fire before checking sync/reload.
  await pageA.waitForTimeout(1200)

  await expect(pageB.getByTestId('notes-textarea')).toHaveValue(
    'Kid has a peanut allergy. Prefer campsites with pools.',
    { timeout: 3000 },
  )

  await pageA.reload()
  await pageA.getByTestId('notes-textarea').waitFor()
  await expect(pageA.getByTestId('notes-textarea')).toHaveValue(
    'Kid has a peanut allergy. Prefer campsites with pools.',
  )

  await contextA.close()
  await contextB.close()
})
