import { act, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { PlanStatus } from '@rv/shared'
import { isPlanBusy, usePlanBusy } from './planBusy'

function Probe({ status }: { status: PlanStatus }) {
  const { busy, markSubmitted } = usePlanBusy(status)
  return (
    <div>
      <span data-testid="busy">{String(busy)}</span>
      <button type="button" onClick={markSubmitted}>
        submit
      </button>
    </div>
  )
}

const busyText = () => screen.getByTestId('busy').textContent

describe('isPlanBusy', () => {
  it('is true only while the backend is actually rewriting the plan', () => {
    expect(isPlanBusy('pending')).toBe(true)
    expect(isPlanBusy('generating')).toBe(true)
    expect(isPlanBusy('ready')).toBe(false)
    expect(isPlanBusy('idle')).toBe(false)
    expect(isPlanBusy('stale')).toBe(false)
    expect(isPlanBusy('error')).toBe(false)
  })
})

describe('usePlanBusy', () => {
  it('is busy while the backend says so', () => {
    render(<Probe status="generating" />)
    expect(busyText()).toBe('true')
  })

  // The gap that caused the incident: a planRequest is a Firestore write and
  // generatePlan is a trigger on it, so for a second or two afterwards the
  // trip is still 'ready'. That is exactly when the button was live again.
  it('is busy immediately after a submit, before the backend has noticed', () => {
    render(<Probe status="ready" />)
    expect(busyText()).toBe('false')

    act(() => screen.getByText('submit').click())
    expect(busyText()).toBe('true')
  })

  it('stays busy across the handover from optimism to backend status', () => {
    const { rerender } = render(<Probe status="ready" />)
    act(() => screen.getByText('submit').click())
    expect(busyText()).toBe('true')

    rerender(<Probe status="generating" />)
    expect(busyText()).toBe('true')

    rerender(<Probe status="ready" />)
    expect(busyText()).toBe('false')
  })

  // Without the ceiling, a request nothing ever picks up would disable the
  // controls permanently — trading a corrupted trip for an unusable screen.
  it('gives up on an unacknowledged submit rather than wedging the controls', () => {
    vi.useFakeTimers()
    try {
      render(<Probe status="ready" />)
      act(() => screen.getByText('submit').click())
      expect(busyText()).toBe('true')

      act(() => void vi.advanceTimersByTime(30_000))
      expect(busyText()).toBe('false')
    } finally {
      vi.useRealTimers()
    }
  })
})
