import { expect, test } from '@playwright/test'
import { getApps, initializeApp } from 'firebase-admin/app'
import { getFirestore } from 'firebase-admin/firestore'

process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:8080'
const PROJECT_ID = 'demo-rv-trip-planner'
if (getApps().length === 0) initializeApp({ projectId: PROJECT_ID })
const adminDb = getFirestore()

async function createTripWithPlan(page: import('@playwright/test').Page) {
  await page.goto('/')
  await page.getByTestId('trip-name-input').waitFor()
  await page.getByTestId('nav-setup').click()
  await page.getByTestId('generate-plan-button').click()
  await expect(page.getByTestId('plan-status')).toHaveText('ready', {
    timeout: 15_000,
  })
  const tripId = await page.evaluate(() => localStorage.getItem('tripId'))
  if (!tripId) throw new Error('tripId missing from localStorage')
  return tripId
}

test('every route country is listed, and its detail page has an empty state before a guide exists', async ({
  page,
}) => {
  await createTripWithPlan(page)

  await page.getByTestId('nav-countries').click()
  await expect(page.getByTestId('countries-list')).toBeVisible()
  // The fixture plan's every day is an overnight stop in Norway.
  await expect(page.getByTestId('country-link-NO')).toContainText('Norway')
  await expect(page.getByTestId('countries-list').locator('li')).toHaveCount(
    1,
  )

  await page.getByTestId('country-link-NO').click()
  await expect(page.getByTestId('country-guide-empty')).toBeVisible()

  // CLAUDE_API_KEY isn't configured in this environment (same caveat as
  // T-14/T-16/T-18/T-22), so the refresh call fails — but it must fail
  // gracefully rather than crash the screen.
  await page.getByTestId('refresh-country-guide').click()
  await expect(page.getByTestId('refresh-error')).toBeVisible({
    timeout: 10_000,
  })
})

test('a generated guide renders all six accordion sections', async ({
  page,
}) => {
  const tripId = await createTripWithPlan(page)

  await adminDb.collection('trips').doc(tripId).collection('countries').doc('NO').set({
    name: 'Norway',
    drivingRules: ['Headlights on at all times.'],
    campingRules: ['Use designated campsites where possible.'],
    freeCampingRules: ['Allemannsretten permits free camping on uncultivated land.'],
    roadFees: {
      summary: 'Tolls are automatic via AutoPASS.',
      howToPay: 'Register your plate online or pay by invoice.',
    },
    speedLimits: {
      urban: '50 km/h',
      rural: '80 km/h',
      motorway: '110 km/h',
    },
    lpgInfo: {
      adapterNeeded: 'Norwegian bayonet adapter',
      commonBrands: ['Kosan Gas'],
      tips: 'LPG stations are less common than in central Europe — plan ahead.',
    },
    generatedAt: new Date().toISOString(),
  })

  await page.goto('/countries/NO')
  await expect(page.getByTestId('country-guide')).toBeVisible()
  await expect(page.getByTestId('country-guide-generated-at')).toBeVisible()

  for (const sectionId of [
    'section-driving-rules',
    'section-camping-rules',
    'section-free-camping-rules',
    'section-road-fees',
    'section-speed-limits',
    'section-lpg-info',
  ]) {
    await expect(page.getByTestId(sectionId)).toBeVisible()
  }
  await expect(page.getByTestId('section-speed-limits')).toContainText(
    '110 km/h',
  )
})
