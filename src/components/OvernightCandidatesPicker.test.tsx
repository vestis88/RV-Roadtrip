import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { OvernightStopCandidate, PlanStatus, Trip, TripDay } from '@rv/shared'
import { usePlanBusy } from '../lib/planBusy'

// A trip that has NOT started yet, which is the state every reported
// occurrence of this bug was in.
const TRIP: Trip = {
  meta: {
    name: 'Copenhagen loop',
    shareCode: 'AB12CD',
    createdAt: '2026-08-01T10:00:00Z',
    version: 1,
  },
  settings: {
    startDate: '2026-08-14',
    endDate: '2026-08-17',
    startPoint: { name: 'Copenhagen', lat: 55.6761, lng: 12.5683 },
    endPoint: { name: 'Copenhagen', lat: 55.6761, lng: 12.5683 },
    travelers: [{ name: 'Traveler', role: 'adult' }],
    interests: ['castles'],
    preferredCountries: ['DK'],
    restDayFrequency: 7,
    maxDriveHoursPerDay: 4,
    vehicle: {
      type: 'RV',
      weightKg: 3500,
      registeredAs: 'car',
      heightM: 2.9,
      lengthM: 6.5,
      widthM: 2.3,
      fuel: 'diesel',
    },
  },
  notes: { freeText: '', updatedAt: '2026-08-01T10:00:00Z' },
  planMeta: { status: 'ready' },
}

const DAY: TripDay = {
  index: 1,
  date: '2026-08-15',
  type: 'drive',
  overnight: { name: 'Helsingor', lat: 56.0361, lng: 12.6136, country: 'DK' },
  summary: 'North along the sound.',
}

const CANDIDATE: OvernightStopCandidate = {
  type: 'campsite',
  name: 'Helsingør Camping',
  description: 'By the sound, walkable to the castle.',
  lat: 56.0361,
  lng: 12.6136,
  country: 'DK',
  source: 'osm',
}

// Only the two edges that leave this component matter here: where the
// candidates come from, and whether a replan was submitted. Everything else
// is the component's own state machine, which is what's under test.
const submitPlanChangeRequest = vi.fn().mockResolvedValue(undefined)

vi.mock('firebase/firestore', () => ({
  collection: () => ({}),
  getDocs: () =>
    Promise.resolve({
      empty: false,
      docs: [{ data: () => CANDIDATE }],
    }),
}))
vi.mock('firebase/functions', () => ({ httpsCallable: () => vi.fn() }))
vi.mock('../lib/firebase', () => ({ db: {}, functions: {} }))
vi.mock('../lib/submitChangeRequest', () => ({
  submitPlanChangeRequest: (...args: unknown[]) =>
    submitPlanChangeRequest(...args),
}))

const { OvernightCandidatesPicker } = await import('./OvernightCandidatesPicker')

/**
 * Wires the picker to usePlanBusy exactly as DayViewScreen does, because the
 * bug was in the wiring rather than in either piece: the picker had its own
 * local `submittingIndex` and never touched the shared busy state at all.
 *
 * `status` stays whatever the caller passes for the whole test — 'ready' is
 * not an artificial setup, it is the real state of the trip for the second or
 * two between the planRequest write landing and generatePlan's trigger
 * claiming it. That interval is the entire bug.
 */
function Harness({ status }: { status: PlanStatus }) {
  const { busy, markSubmitted } = usePlanBusy(status)
  return (
    <OvernightCandidatesPicker
      tripId="trip1"
      trip={TRIP}
      dayId="day1"
      day={DAY}
      priorDayIds={['day0']}
      planBusy={busy}
      onSubmitted={markSubmitted}
    />
  )
}

beforeEach(() => {
  submitPlanChangeRequest.mockClear()
  window.localStorage.clear()
})

describe('OvernightCandidatesPicker', () => {
  async function openAndPick() {
    fireEvent.click(screen.getByTestId('change-overnight-toggle'))
    fireEvent.click(
      await screen.findByTestId('overnight-candidate-pick-campsite-0'),
    )
  }

  it('submits the pick as a scoped replan', async () => {
    render(<Harness status="ready" />)
    await openAndPick()

    await waitFor(() => expect(submitPlanChangeRequest).toHaveBeenCalledTimes(1))
    const [tripId, , changeText, lockedDayIds] =
      submitPlanChangeRequest.mock.calls[0]
    expect(tripId).toBe('trip1')
    expect(changeText).toContain('Helsingør Camping')
    expect(lockedDayIds).toEqual(['day0'])
  })

  // The 2026-08-13 incident, and the reason this file exists. The traveler
  // picked a stop, the panel closed, and — with the trip still 'ready'
  // because the trigger hadn't fired yet — the button came straight back.
  // Tapping it again submitted a second replan against a plan that was
  // already being replaced.
  it('refuses a second pick during the window before the backend acknowledges the first', async () => {
    render(<Harness status="ready" />)
    await openAndPick()
    await waitFor(() => expect(submitPlanChangeRequest).toHaveBeenCalledTimes(1))

    const toggle = await screen.findByTestId('change-overnight-toggle')
    expect(toggle).toBeDisabled()
    fireEvent.click(toggle)
    expect(screen.queryByTestId('overnight-candidates-panel')).toBeNull()
    expect(submitPlanChangeRequest).toHaveBeenCalledTimes(1)
  })

  // The acknowledgement has to be on screen before the controls vanish —
  // a panel that closes into an unchanged page is what "nothing happened"
  // looked like, and what invited the second tap in the first place.
  it('reports the submission before closing the panel', async () => {
    render(<Harness status="ready" />)
    await openAndPick()

    await waitFor(() =>
      expect(screen.getByTestId('change-overnight-toggle')).toHaveTextContent(
        'Updating the plan…',
      ),
    )
  })

  it('cannot be opened at all while the backend is already replanning', () => {
    render(<Harness status="generating" />)
    const toggle = screen.getByTestId('change-overnight-toggle')
    expect(toggle).toBeDisabled()
    fireEvent.click(toggle)
    expect(screen.queryByTestId('overnight-candidates-panel')).toBeNull()
  })
})
