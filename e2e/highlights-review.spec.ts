import { expect, test } from './fixtures.js'
import { getApps, initializeApp } from 'firebase-admin/app'
import { getFirestore } from 'firebase-admin/firestore'

process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:8080'
const PROJECT_ID = 'demo-rv-trip-planner'
if (getApps().length === 0) initializeApp({ projectId: PROJECT_ID })
const adminDb = getFirestore()

// No lat/lng on these candidates on purpose — that's the shape the panel
// gets whenever server-side geocoding degraded (no Places key, a town that
// didn't resolve), and it must still render, just without detour figures.
const FIXTURE_HIGHLIGHTS = {
  regions: [
    {
      region: 'Fjord country',
      country: 'NO',
      reasoning: 'Dramatic scenery, great for an active family.',
      candidateStops: [
        {
          town: 'Lillehammer',
          country: 'NO',
          why: 'Olympic sights and a family theme park.',
          priority: 'nice-if-convenient',
        },
        {
          town: 'Geiranger',
          country: 'NO',
          why: 'World-famous fjord viewpoints.',
          priority: 'worth-a-detour',
        },
      ],
    },
  ],
}

// A long enough "why" that a single-line CSS truncation would visibly eat
// most of it — the exact failure the traveler hit on a real phone.
const LONG_WHY =
  "Sitting at the head of a long lake under forested ridges, this town pairs the 1994 Olympic ski-jump arena and bobsleigh track with Maihaugen, one of Europe's largest open-air museums. The Hunderfossen family park is a short drive north. For a family with an eight-year-old who likes castles and being outdoors, it is the rare stop where the adults and the kid both get a full day they wanted."

// Coordinates chosen to be hand-checkable against a start/end laid out along
// a single meridian below: the must-see and one candidate sit exactly on the
// line, one candidate sits off to the side.
const FIXTURE_LOCATED_HIGHLIGHTS = {
  regions: [
    {
      region: 'Meridian country',
      country: 'NO',
      reasoning: 'A synthetic corridor with predictable geometry.',
      candidateStops: [
        {
          town: 'Midpoint',
          country: 'NO',
          why: LONG_WHY,
          priority: 'must-see',
          lat: 52,
          lng: 10,
        },
        {
          town: 'On The Line',
          country: 'NO',
          why: 'Sits exactly on the route between the start and the must-see.',
          priority: 'worth-a-detour',
          lat: 51,
          lng: 10,
        },
        {
          town: 'Off To The Side',
          country: 'NO',
          why: 'A degree east of the corridor, so it costs real extra driving.',
          priority: 'worth-a-detour',
          lat: 51,
          lng: 11,
        },
        {
          town: 'Unlocatable',
          country: 'NO',
          why: 'Geocoding never resolved this one, so it has no coordinates.',
          priority: 'nice-if-convenient',
        },
      ],
    },
  ],
}

const MERIDIAN_ENDPOINTS = {
  'settings.startPoint': { name: 'South end', lat: 50, lng: 10 },
  'settings.endPoint': { name: 'North end', lat: 54, lng: 10 },
}

async function getTripId(
  page: import('@playwright/test').Page,
): Promise<string> {
  await page.goto('/')
  await page.getByTestId('trip-name-input').waitFor()
  const tripId = await page.evaluate(() => localStorage.getItem('tripId'))
  if (!tripId) throw new Error('tripId missing from localStorage')
  return tripId
}

test('checking "review before generating" is off by default and can be enabled', async ({
  page,
}) => {
  await getTripId(page)
  await expect(page.getByTestId('review-highlights-checkbox')).not.toBeChecked()
  await page.getByTestId('review-highlights-checkbox').check()
  await expect(page.getByTestId('review-highlights-checkbox')).toBeChecked()
})

test('the highlights review panel renders regions, supports re-ranking, removing, and a note, and submits a continuation request', async ({
  page,
}) => {
  const tripId = await getTripId(page)

  await adminDb.collection('trips').doc(tripId).update({
    'planMeta.status': 'awaiting-highlights-review',
    'planMeta.pendingHighlights': FIXTURE_HIGHLIGHTS,
  })

  await page.getByTestId('highlights-review-panel').waitFor()
  await expect(page.getByTestId('highlights-region-0')).toContainText(
    'Fjord country',
  )
  await expect(page.getByTestId('highlights-region-0')).toContainText(
    'Dramatic scenery',
  )
  await expect(page.getByTestId('highlights-stop-0-0')).toContainText(
    'Lillehammer',
  )
  await expect(page.getByTestId('highlights-stop-priority-0-0')).toHaveText(
    'Nice if convenient',
  )

  // Promote Lillehammer up two tiers to must-see.
  await page.getByTestId('highlights-stop-up-0-0').click()
  await expect(page.getByTestId('highlights-stop-priority-0-0')).toHaveText(
    'Worth a detour',
  )
  await page.getByTestId('highlights-stop-up-0-0').click()
  await expect(page.getByTestId('highlights-stop-priority-0-0')).toHaveText(
    'Must-see',
  )
  // Already at the top tier — further "up" clicks must be a no-op.
  await expect(page.getByTestId('highlights-stop-up-0-0')).toBeDisabled()

  // Remove Geiranger (index 1 — nothing reorders any more), leaving only
  // Lillehammer.
  await page.getByTestId('highlights-stop-remove-0-1').click()
  await expect(page.getByTestId('highlights-stop-0-0')).toContainText(
    'Lillehammer',
  )
  await expect(page.getByTestId('highlights-stop-0-1')).toHaveCount(0)

  await page
    .getByTestId('highlights-review-note')
    .fill('must include a waterfall stop')

  await page.getByTestId('highlights-review-continue').click()

  // The continuation request lands in Firestore with the edited state —
  // actual generation then hits the same no-credentials error every other
  // Claude-backed feature does in this sandbox (see countries.spec.ts), so
  // this confirms the submit path rather than a full end-to-end plan.
  await expect
    .poll(
      async () => {
        const snap = await adminDb
          .collection('planRequests')
          .where('tripId', '==', tripId)
          .where('kind', '==', 'continueFromHighlights')
          .get()
        return snap.size
      },
      { timeout: 10_000 },
    )
    .toBe(1)

  const [requestDoc] = (
    await adminDb
      .collection('planRequests')
      .where('tripId', '==', tripId)
      .where('kind', '==', 'continueFromHighlights')
      .get()
  ).docs
  const data = requestDoc.data()
  expect(data.reviewNote).toBe('must include a waterfall stop')
  expect(data.editedHighlights.regions[0].candidateStops).toHaveLength(1)
  expect(data.editedHighlights.regions[0].candidateStops[0].town).toBe(
    'Lillehammer',
  )
  expect(data.editedHighlights.regions[0].candidateStops[0].priority).toBe(
    'must-see',
  )
})

test('the panel shows a map and no drag-to-reorder affordance at all', async ({
  page,
}) => {
  const tripId = await getTripId(page)

  await adminDb.collection('trips').doc(tripId).update({
    'planMeta.status': 'awaiting-highlights-review',
    'planMeta.pendingHighlights': FIXTURE_HIGHLIGHTS,
  })

  await page.getByTestId('highlights-review-panel').waitFor()

  // The map container mounts even in this sandbox, where the Google Maps JS
  // API itself is network-blocked (see e2e/map.spec.ts) — so this asserts the
  // panel reserves and renders the map slot, not that tiles paint.
  await expect(page.getByTestId('highlights-map')).toBeVisible()

  // Native HTML5 drag-and-drop never worked on a touch device, so both the
  // behaviour and the grip glyph that advertised it are gone.
  const panel = page.getByTestId('highlights-review-panel')
  await expect(panel.locator('[draggable="true"]')).toHaveCount(0)
  await expect(panel.locator('.cursor-grab')).toHaveCount(0)
  await expect(panel.getByText('⠿')).toHaveCount(0)
})

test('a stop description is shown in full rather than truncated to one line', async ({
  page,
}) => {
  const tripId = await getTripId(page)

  await adminDb
    .collection('trips')
    .doc(tripId)
    .update({
      ...MERIDIAN_ENDPOINTS,
      'planMeta.status': 'awaiting-highlights-review',
      'planMeta.pendingHighlights': FIXTURE_LOCATED_HIGHLIGHTS,
    })

  await page.getByTestId('highlights-review-panel').waitFor()

  const firstStop = page.getByTestId('highlights-stop-0-0')
  // The whole multi-sentence description is in the DOM …
  await expect(firstStop).toContainText(LONG_WHY)
  // … and nothing inside the row clips it to a single ellipsised line.
  await expect(firstStop.locator('.truncate')).toHaveCount(0)
})

test('each stop shows its estimated detour off the ideal route, and it updates live', async ({
  page,
}) => {
  const tripId = await getTripId(page)

  await adminDb
    .collection('trips')
    .doc(tripId)
    .update({
      ...MERIDIAN_ENDPOINTS,
      'planMeta.status': 'awaiting-highlights-review',
      'planMeta.pendingHighlights': FIXTURE_LOCATED_HIGHLIGHTS,
    })

  await page.getByTestId('highlights-review-panel').waitFor()

  // Backbone is start (50,10) → the must-see (52,10) → end (54,10): a
  // straight meridian.
  await expect(page.getByTestId('highlights-stop-detour-0-0')).toHaveText(
    'On route',
  )
  // (51,10) lies exactly on the first leg — nothing extra to drive.
  await expect(page.getByTestId('highlights-stop-detour-0-1')).toHaveText(
    '≈+0 km detour',
  )
  // (51,11) is a degree of longitude east of the corridor; the cheapest
  // insertion into leg (50,10)→(52,10) costs ~40 km.
  await expect(page.getByTestId('highlights-stop-detour-0-2')).toHaveText(
    '≈+40 km detour',
  )
  // No coordinates means no figure can honestly be shown — not "+0 km".
  await expect(page.getByTestId('highlights-stop-detour-0-3')).toHaveCount(0)

  // Promoting a stop to must-see puts it INTO the backbone, so it stops
  // being a detour and starts being part of what everything else is
  // measured against.
  await page.getByTestId('highlights-stop-up-0-2').click()
  await expect(page.getByTestId('highlights-stop-detour-0-2')).toHaveText(
    'On route',
  )
})
