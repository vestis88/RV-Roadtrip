import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { OvernightStopCandidate, PlanStatus, TripDay } from '@rv/shared'
import { usePlanBusy } from '../lib/planBusy'

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
const chooseOvernight = vi.fn().mockResolvedValue(undefined)

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
vi.mock('../lib/chooseOvernight', () => ({
  chooseOvernight: (...args: unknown[]) => chooseOvernight(...args),
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
  const { busy } = usePlanBusy(status)
  return (
    <OvernightCandidatesPicker
      tripId="trip1"
      dayId="day1"
      day={DAY}
      planBusy={busy}
    />
  )
}

beforeEach(() => {
  chooseOvernight.mockClear()
  window.localStorage.clear()
})

describe('OvernightCandidatesPicker', () => {
  async function openAndPick() {
    fireEvent.click(screen.getByTestId('change-overnight-toggle'))
    fireEvent.click(
      await screen.findByTestId('overnight-candidate-pick-campsite-0'),
    )
  }

  /**
   * Reported 2026-09-02: *"I went in to add alternative overnight stops
   * through change overnight stops. It was not saved now that I went back to
   * the same day. I want the stops saved!!"*
   *
   * It was never saved: picking submitted a scoped REPLAN and waited for a
   * Claude pass to rewrite the trip, which with the API account out of
   * credit never arrived. The choice is one field on one day now.
   */
  it('saves the pick straight onto the day', async () => {
    render(<Harness status="ready" />)
    await openAndPick()

    await waitFor(() => expect(chooseOvernight).toHaveBeenCalledTimes(1))
    const [tripId, dayId, , candidate] = chooseOvernight.mock.calls[0]
    expect(tripId).toBe('trip1')
    expect(dayId).toBe('day1')
    expect((candidate as OvernightStopCandidate).name).toBe(
      'Helsingør Camping',
    )
  })

  // The panel closes because the thing it was for is done — not because a
  // request is pending somewhere. Nothing to acknowledge, nothing to wait
  // for, and the choice is already on the day behind it.
  it('closes once the choice is written', async () => {
    render(<Harness status="ready" />)
    await openAndPick()

    await waitFor(() =>
      expect(screen.queryByTestId('overnight-candidates-panel')).toBeNull(),
    )
  })

  // And it can be changed again immediately: the 2026-08-13 double-submit
  // guard existed because two replans against overlapping state corrupted
  // the trip. Writing one field twice is simply the second answer.
  it('lets the traveller change their mind straight away', async () => {
    render(<Harness status="ready" />)
    await openAndPick()
    await waitFor(() => expect(chooseOvernight).toHaveBeenCalledTimes(1))

    const toggle = await screen.findByTestId('change-overnight-toggle')
    expect(toggle).toBeEnabled()
  })

  // A generation owns the days while it runs and would overwrite a choice
  // made underneath it — the one reason this still watches planBusy.
  it('cannot be opened while a generation is rewriting the trip', () => {
    render(<Harness status="generating" />)
    const toggle = screen.getByTestId('change-overnight-toggle')
    expect(toggle).toBeDisabled()
    fireEvent.click(toggle)
    expect(screen.queryByTestId('overnight-candidates-panel')).toBeNull()
  })
})
