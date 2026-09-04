import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { TripDay } from '@rv/shared'

const call = vi.fn()
vi.mock('firebase/functions', () => ({
  httpsCallable: () => call,
}))
vi.mock('../lib/firebase', () => ({ functions: {} }))

const { OvernightSection } = await import('./OvernightSection')

const day = {
  overnight: { name: 'Cortina', lat: 46.54, lng: 12.13, country: 'IT', type: 'campsite' },
} as unknown as TripDay

function renderRow() {
  return render(
    <OvernightSection
      tripId="t1"
      dayId="d1"
      day={day}
      options={[]}
      selectedPlaceId={undefined}
      onSelect={() => {}}
      planBusy={false}
    />,
  )
}

/**
 * Reported with a screenshot on 2026-09-03: pressing the button produced two
 * identical red lines. An empty CardRow renders its `empty` slot AND its
 * footer, and the failure had been put in both.
 */
describe('OvernightSection', () => {
  it("reports a failure once, in the server's own words", async () => {
    call.mockRejectedValueOnce({
      code: 'functions/internal',
      message: 'Could not look for places to sleep: credit balance is too low',
    })
    vi.spyOn(console, 'error').mockImplementation(() => {})
    renderRow()
    fireEvent.click(screen.getByTestId('overnight-row-fill'))
    await waitFor(() =>
      expect(screen.getAllByTestId('overnight-row-error')).toHaveLength(1),
    )
    expect(screen.getByTestId('overnight-row-error').textContent).toContain(
      'credit balance is too low',
    )
  })

  it('says nothing was found when the look succeeds but finds none', async () => {
    call.mockResolvedValueOnce({ data: { candidates: [] } })
    renderRow()
    fireEvent.click(screen.getByTestId('overnight-row-fill'))
    await waitFor(() => screen.getByTestId('overnight-row-empty'))
    expect(screen.queryByTestId('overnight-row-error')).toBeNull()
  })
})
