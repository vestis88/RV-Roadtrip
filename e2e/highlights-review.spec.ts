import { expect, test } from './fixtures.js'
import { getApps, initializeApp } from 'firebase-admin/app'
import { getFirestore } from 'firebase-admin/firestore'

process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:8080'
const PROJECT_ID = 'demo-rv-trip-planner'
if (getApps().length === 0) initializeApp({ projectId: PROJECT_ID })
const adminDb = getFirestore()

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

async function getTripId(page: import('@playwright/test').Page): Promise<string> {
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
  await expect(
    page.getByTestId('highlights-stop-0-0'),
  ).toContainText('Lillehammer')
  await expect(
    page.getByTestId('highlights-stop-priority-0-0'),
  ).toHaveText('Nice if convenient')

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

  // Reorder within the region via drag-and-drop: drag Lillehammer (index 0)
  // onto Geiranger (index 1) — my component tracks drag source via a ref,
  // not event.dataTransfer, so plain dragstart/drop events are enough.
  await page.getByTestId('highlights-stop-0-0').dispatchEvent('dragstart')
  await page.getByTestId('highlights-stop-0-1').dispatchEvent('drop')
  // Geiranger is now first.
  await expect(page.getByTestId('highlights-stop-0-0')).toContainText(
    'Geiranger',
  )
  await expect(page.getByTestId('highlights-stop-0-1')).toContainText(
    'Lillehammer',
  )

  // Remove Geiranger (now at index 0), leaving only Lillehammer.
  await page.getByTestId('highlights-stop-remove-0-0').click()
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
