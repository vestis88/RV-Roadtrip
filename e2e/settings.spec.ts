import { expect, test } from './fixtures.js'

async function setRange(locator: import('@playwright/test').Locator, value: string) {
  await locator.evaluate((el: HTMLInputElement, v: string) => {
    const proto = Object.getPrototypeOf(el) as object
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set
    setter?.call(el, v)
    el.dispatchEvent(new Event('input', { bubbles: true }))
    el.dispatchEvent(new Event('change', { bubbles: true }))
  }, value)
}

test('settings form fills, persists across reload, and flips plan status to stale', async ({
  page,
}) => {
  await page.goto('/')
  await page.getByTestId('trip-name-input').waitFor()
  await expect(page.getByTestId('plan-status')).toHaveText('idle')

  await page.getByTestId('start-date-input').fill('2026-07-10')
  await page.getByTestId('end-date-input').fill('2026-08-02')

  await page.getByTestId('start-point-input').fill('Oslo, Norway')
  await page.getByTestId('start-point-input').blur()
  await page.getByTestId('end-point-input').fill('Rome, Italy')
  await page.getByTestId('end-point-input').blur()

  await page.getByTestId('traveler-add').click()
  await page.getByTestId('traveler-name-0').fill('Bim')
  await page.getByTestId('traveler-add').click()
  await page.getByTestId('traveler-name-1').fill('Kid')
  await page.getByTestId('traveler-role-1').selectOption('child')
  await page.getByTestId('traveler-age-1').fill('8')

  await page.getByTestId('interest-chip-hiking').click()
  await page.getByTestId('interest-chip-beaches').click()
  await page.getByTestId('interest-free-entry').fill('waterfalls')
  await page.getByTestId('interest-free-entry-add').click()

  await page.getByTestId('country-chip-NO').click()
  await page.getByTestId('country-chip-IT').click()

  await setRange(page.getByTestId('rest-day-frequency-input'), '5')
  await setRange(page.getByTestId('max-drive-hours-input'), '6')

  await expect(page.getByTestId('plan-status')).toHaveText('stale')

  // Every field commits its own Firestore write independently; give the
  // last one (max-drive-hours) time to actually reach the emulator before
  // reloading, since 'plan-status' already flipped to stale on the very
  // first edit and so doesn't prove later writes have landed.
  await page.waitForTimeout(500)

  await page.reload()
  await page.getByTestId('trip-name-input').waitFor()

  await expect(page.getByTestId('start-date-input')).toHaveValue('2026-07-10')
  await expect(page.getByTestId('end-date-input')).toHaveValue('2026-08-02')
  await expect(page.getByTestId('start-point-input')).toHaveValue(
    'Oslo, Norway',
  )
  await expect(page.getByTestId('end-point-input')).toHaveValue('Rome, Italy')
  await expect(page.getByTestId('traveler-name-0')).toHaveValue('Bim')
  await expect(page.getByTestId('traveler-name-1')).toHaveValue('Kid')
  await expect(page.getByTestId('traveler-role-1')).toHaveValue('child')
  await expect(page.getByTestId('traveler-age-1')).toHaveValue('8')
  await expect(page.getByTestId('interest-chip-hiking')).toHaveAttribute(
    'aria-pressed',
    'true',
  )
  await expect(page.getByTestId('interest-chip-beaches')).toHaveAttribute(
    'aria-pressed',
    'true',
  )
  await expect(page.getByTestId('interest-chip-waterfalls')).toHaveAttribute(
    'aria-pressed',
    'true',
  )
  await expect(page.getByTestId('country-chip-NO')).toHaveAttribute(
    'aria-pressed',
    'true',
  )
  await expect(page.getByTestId('country-chip-IT')).toHaveAttribute(
    'aria-pressed',
    'true',
  )
  await expect(page.getByTestId('rest-day-frequency-input')).toHaveValue('5')
  await expect(page.getByTestId('max-drive-hours-input')).toHaveValue('6')
  await expect(page.getByTestId('plan-status')).toHaveText('stale')
})
