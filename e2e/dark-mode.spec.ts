import { expect, test } from './fixtures.js'
import { getApps, initializeApp } from 'firebase-admin/app'
import { getFirestore } from 'firebase-admin/firestore'
import { evaluateWithRetry } from './helpers/seedFixturePlan.js'
import { signIn } from './helpers/signIn.js'

process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:8080'
const PROJECT_ID = 'demo-rv-trip-planner'
if (getApps().length === 0) initializeApp({ projectId: PROJECT_ID })
const adminDb = getFirestore()

/**
 * Reported 2026-08-24 from an iPad: "Dark mode is not great here."
 *
 * The cause was not a component's colours — the document never declared
 * `color-scheme`, so the browser kept its LIGHT defaults regardless of
 * `prefers-color-scheme`. The inherited `color` stayed black, and every
 * control that set only a border (the stay/order/sleep/done controls added
 * the day before) rendered black text on a near-black card.
 *
 * Asserted by measured contrast rather than by class name, because what
 * broke was a computed value, not a missing utility: the same failure would
 * pass any "does it have dark:text-…" check as long as an ancestor's
 * inherited colour was wrong.
 */

/**
 * WCAG relative luminance from sRGB channels.
 *
 * Channels rather than a colour string on purpose: Tailwind v4 emits
 * `oklch(…)`, and `getComputedStyle` hands that back verbatim rather than
 * resolving it to rgb. The first version of this test parsed the three
 * numbers out of `oklch(0.97 0 0)` as if they were 0–255 channels and
 * reported a contrast of 1.0 for what is in fact near-white on dark grey.
 * The conversion is done in the page instead — see rgbOf.
 */
function luminance([r, g, b]: number[]): number {
  const [rl, gl, bl] = [r, g, b].map((value) => {
    const channel = value / 255
    return channel <= 0.03928
      ? channel / 12.92
      : ((channel + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * rl + 0.7152 * gl + 0.0722 * bl
}

function contrastRatio(a: number[], b: number[]): number {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (light + 0.05) / (dark + 0.05)
}

test.use({ colorScheme: 'dark' })

test('the board stays legible in dark mode', async ({ page }) => {
  await signIn(page)
  await page.getByTestId('trip-name-input').waitFor()
  const tripId = await evaluateWithRetry(page, () =>
    localStorage.getItem('tripId'),
  )
  if (!tripId) throw new Error('tripId missing from localStorage')

  await adminDb
    .collection('trips')
    .doc(tripId)
    .update({
      'settings.startPoint': { name: 'Munich, Germany', lat: 48.14, lng: 11.58 },
      'settings.endPoint': { name: 'Innsbruck, Austria', lat: 47.27, lng: 11.4 },
    })
  // Locked, because that is the state that grows the controls the report was
  // about — stay duration, order, where to sleep, and marking it done.
  const stop = await adminDb
    .collection('trips')
    .doc(tripId)
    .collection('corridorStops')
    .add({
      name: 'Neuschwanstein Castle',
      lat: 47.5576,
      lng: 10.7498,
      country: 'DE',
      why: 'The castle itself.',
      status: 'locked',
      linkedDayIds: [],
      priority: 'must-see',
      rank: 0,
    })

  await page.getByTestId('nav-map').click()
  await page.getByTestId('explore-map-screen').waitFor()
  const doneButton = page.getByTestId(`explore-candidate-mark-done-${stop.id}`)
  await doneButton.waitFor()

  // The declaration that made every one of these legible at once.
  const scheme = await page.evaluate(() =>
    getComputedStyle(document.documentElement).colorScheme,
  )
  expect(scheme).toContain('dark')

  // 4.5:1 is WCAG AA for body text. The reported state measured around 1.1.
  for (const testId of [
    `explore-candidate-mark-done-${stop.id}`,
    `explore-candidate-move-up-${stop.id}`,
    `explore-candidate-stay-hours-${stop.id}`,
  ]) {
    const control = page.getByTestId(testId)
    await control.waitFor()
    const { color, background } = await control.evaluate((element) => {
      // Whatever colour syntax the stylesheet used — oklch here — painted
      // onto a 1x1 canvas and read back as sRGB, so this test measures what
      // the screen shows rather than what the declaration said.
      const canvas = document.createElement('canvas')
      canvas.width = 1
      canvas.height = 1
      const context = canvas.getContext('2d')
      const rgbOf = (value: string): number[] => {
        if (!context) return [0, 0, 0]
        context.clearRect(0, 0, 1, 1)
        context.fillStyle = value
        context.fillRect(0, 0, 1, 1)
        const [r, g, b] = context.getImageData(0, 0, 1, 1).data
        return [r, g, b]
      }

      // Walk up for the first ancestor that actually paints, since the
      // control's own background can legitimately be transparent.
      let node: HTMLElement | null = element as HTMLElement
      let background = 'white'
      while (node) {
        const candidate = getComputedStyle(node).backgroundColor
        if (candidate && !/rgba\(0, 0, 0, 0\)|transparent/.test(candidate)) {
          background = candidate
          break
        }
        node = node.parentElement
      }
      return {
        color: rgbOf(getComputedStyle(element).color),
        background: rgbOf(background),
      }
    })
    expect(
      contrastRatio(color, background),
      `${testId} renders rgb(${color}) on rgb(${background})`,
    ).toBeGreaterThan(4.5)
  }
})
