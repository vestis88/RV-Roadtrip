import { expect, test } from './fixtures.js'
import { getApps, initializeApp } from 'firebase-admin/app'
import { getFirestore } from 'firebase-admin/firestore'
import {
  DEFAULT_COUNTRY_BRIEF_SECTIONS,
  countryGuideSectionDocId,
  type CountryBriefSection,
  type Vehicle,
} from '@rv/shared'
import {
  createTripWithPlan,
  evaluateWithRetry,
} from './helpers/seedFixturePlan.js'

process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:8080'
const PROJECT_ID = 'demo-rv-trip-planner'
if (getApps().length === 0) initializeApp({ projectId: PROJECT_ID })
const adminDb = getFirestore()

const FREE_CAMPING = DEFAULT_COUNTRY_BRIEF_SECTIONS.find(
  (section) => section.id === 'free-camping-rules',
)!
const SPEED_LIMITS = DEFAULT_COUNTRY_BRIEF_SECTIONS.find(
  (section) => section.id === 'speed-limits',
)!

async function vehicleOf(tripId: string): Promise<Vehicle> {
  const snap = await adminDb.collection('trips').doc(tripId).get()
  return snap.data()!.settings.vehicle as Vehicle
}

/**
 * Writes a researched section exactly where the callable would, so the
 * screen has to agree with countryGuideSectionDocId to find it — which is
 * the whole correctness story behind reusing research across trips.
 */
async function seedSection(
  countryCode: string,
  section: CountryBriefSection,
  vehicle: Vehicle,
  items: string[],
) {
  await adminDb
    .collection('countryGuideSections')
    .doc(countryGuideSectionDocId({ countryCode, section, vehicle }))
    .set({
      countryCode,
      sectionId: section.id,
      title: section.title,
      items,
      sources: ['https://example.test/source'],
      generatedAt: new Date().toISOString(),
    })
}

test('every route country is listed, and its sections start un-researched', async ({
  page,
}) => {
  // The research call below waits on the functions emulator's cold start,
  // which can outrun the default 30s per-test budget on its own.
  test.setTimeout(90_000)
  await createTripWithPlan(page)

  await page.getByTestId('nav-countries').click()
  await expect(page.getByTestId('countries-list')).toBeVisible()
  // The fixture plan's every day is an overnight stop in Norway.
  await expect(page.getByTestId('country-link-NO')).toContainText('Norway')
  await expect(page.getByTestId('countries-list').locator('li')).toHaveCount(1)

  await page.getByTestId('country-link-NO').click()
  // The brief is visible before any research exists — the traveler can see
  // (and edit) what *would* be looked up, which is the point of surfacing it.
  await expect(page.getByTestId('country-section-speed-limits')).toBeVisible()
  await expect(page.getByTestId('section-empty-speed-limits')).toBeVisible()

  // CLAUDE_API_KEY isn't configured in this environment (same caveat as the
  // other Claude-backed tests), so research fails — gracefully.
  await page.getByTestId('section-research-speed-limits').click()
  await expect(page.getByTestId('research-error')).toBeVisible({
    timeout: 30_000,
  })
})

test('a researched section renders its findings, and un-researched ones stay empty beside it', async ({
  page,
}) => {
  const tripId = await createTripWithPlan(page)
  const vehicle = await vehicleOf(tripId)
  await seedSection('NO', SPEED_LIMITS, vehicle, [
    'Motorway: 110 km/h.',
    'Over 3,500kg registered as a car: 100 km/h on motorways.',
  ])

  await page.goto('/countries/NO')
  await expect(page.getByTestId('country-section-speed-limits')).toContainText(
    '110 km/h',
  )
  // The neighbouring section is untouched — sections are independent, which
  // is what lets one be researched without disturbing the rest.
  await expect(page.getByTestId('section-empty-camping-rules')).toBeVisible()
})

// Reuse across trips (asked for 2026-08-02) — a vehicle-independent section
// researched once must show up on a completely different trip without
// spending a second Claude call.
test('research done on one trip shows on another trip', async ({ page }) => {
  const firstTripId = await createTripWithPlan(page)
  const vehicle = await vehicleOf(firstTripId)
  await seedSection('NO', FREE_CAMPING, vehicle, [
    'Allemannsretten allows free camping on uncultivated land.',
  ])

  await page.goto('/countries/NO')
  await expect(
    page.getByTestId('country-section-free-camping-rules'),
  ).toContainText('Allemannsretten')

  // A brand-new trip, with no country data of its own anywhere. The
  // research must follow the traveler, not the trip that paid for it.
  await page.goto('/')
  await page.getByTestId('trip-switcher-toggle').click()
  await page.getByTestId('new-trip-button').click()
  // Poll for the switch itself rather than for an empty name field: this
  // trip's fixture plan leaves the name empty too, so that assertion would
  // pass before the new trip existed.
  await expect
    .poll(
      async () => evaluateWithRetry(page, () => localStorage.getItem('tripId')),
      { timeout: 15_000 },
    )
    .not.toBe(firstTripId)
  await page.goto('/countries/NO')
  await expect(
    page.getByTestId('country-section-free-camping-rules'),
  ).toContainText('Allemannsretten')
})

test('adding a research item adds one section and leaves researched ones alone', async ({
  page,
}) => {
  const tripId = await createTripWithPlan(page)
  const vehicle = await vehicleOf(tripId)
  await seedSection('NO', FREE_CAMPING, vehicle, [
    'Allemannsretten allows free camping on uncultivated land.',
  ])

  await page.goto('/countries/NO')
  await expect(
    page.getByTestId('country-section-free-camping-rules'),
  ).toContainText('Allemannsretten')

  await page.getByTestId('add-research-section').click()
  await page.getByTestId('section-editor-title').fill('Drinking water')
  await page
    .getByTestId('section-editor-brief')
    .fill('Where to refill fresh drinking water, and whether it costs anything.')
  await page.getByTestId('section-editor-save').click()

  await expect(page.getByTestId('country-section-drinking-water')).toBeVisible()
  await expect(page.getByTestId('section-empty-drinking-water')).toBeVisible()
  // The already-answered section keeps its answer — adding an item must not
  // invalidate anything already researched.
  await expect(
    page.getByTestId('country-section-free-camping-rules'),
  ).toContainText('Allemannsretten')

  // And it persists on the account, not the trip.
  await page.reload()
  await expect(page.getByTestId('country-section-drinking-water')).toBeVisible()
})
