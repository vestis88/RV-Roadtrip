import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import { useCurrentPosition } from './useCurrentPosition'

type SuccessFn = (fix: {
  coords: { latitude: number; longitude: number; accuracy: number }
}) => void
type ErrorFn = (error: { code: number; PERMISSION_DENIED: number }) => void

function stubGeolocation() {
  let success: SuccessFn | undefined
  let failure: ErrorFn | undefined
  const clearWatch = vi.fn()
  vi.stubGlobal('navigator', {
    geolocation: {
      watchPosition: (ok: SuccessFn, bad: ErrorFn) => {
        success = ok
        failure = bad
        return 7
      },
      clearWatch,
    },
  })
  return {
    fix: (lat: number, lng: number) =>
      success?.({ coords: { latitude: lat, longitude: lng, accuracy: 12 } }),
    fail: (code: number) => failure?.({ code, PERMISSION_DENIED: 1 }),
    clearWatch,
  }
}

afterEach(() => vi.unstubAllGlobals())

/**
 * Requested 2026-08-23: "Right now I can't see my position on the map."
 *
 * The fix was already being taken — useExecutionMode samples one every
 * thirty minutes to measure drift — but only ever measured, never drawn.
 * Tested here rather than in e2e because the marker itself is an
 * AdvancedMarker child and only mounts inside a live Google map.
 */
describe('useCurrentPosition', () => {
  it('reports the position once the browser has one', async () => {
    const geo = stubGeolocation()
    const { result } = renderHook(() => useCurrentPosition())
    act(() => geo.fix(61.77, 9.54))
    await waitFor(() => expect(result.current.position).not.toBeNull())
    expect(result.current.position).toMatchObject({ lat: 61.77, lng: 9.54 })
  })

  // Saying no is an answer, not a failure. The map carries on without a
  // marker rather than nagging or showing something unactionable.
  it('records a refusal so the screen can explain itself', async () => {
    const geo = stubGeolocation()
    const { result } = renderHook(() => useCurrentPosition())
    act(() => geo.fail(1))
    await waitFor(() => expect(result.current.denied).toBe(true))
  })

  /**
   * A timeout or a lost fix is temporary and the watch keeps trying.
   * Treating those as denial would hide the marker for the rest of the
   * session over one bad reading in a tunnel.
   */
  it('does not treat a lost fix as a refusal', async () => {
    const geo = stubGeolocation()
    const { result } = renderHook(() => useCurrentPosition())
    act(() => geo.fail(3))
    await waitFor(() => expect(result.current.denied).toBe(false))
  })

  it('stops watching when nothing is looking any more', () => {
    const geo = stubGeolocation()
    const { unmount } = renderHook(() => useCurrentPosition())
    unmount()
    expect(geo.clearWatch).toHaveBeenCalledWith(7)
  })

  it('asks for nothing when disabled', () => {
    const geo = stubGeolocation()
    renderHook(() => useCurrentPosition(false))
    expect(geo.clearWatch).not.toHaveBeenCalled()
  })
})
