import { render } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { MapPanner } from './MapPanner'

const panTo = vi.fn()
// One stable instance, matching the real useMap(): it hands back the map
// held in context, not a fresh object per render. Returning a new object
// here would re-run the effect on every render for reasons that have
// nothing to do with the component under test.
const mapInstance = { panTo }
vi.mock('@vis.gl/react-google-maps', () => ({
  useMap: () => mapInstance,
}))

beforeEach(() => panTo.mockClear())

describe('MapPanner', () => {
  it('pans to the selected target', () => {
    render(<MapPanner target={{ lat: 59.91, lng: 10.75 }} />)
    expect(panTo).toHaveBeenCalledWith({ lat: 59.91, lng: 10.75 })
  })

  it('does nothing without a selection', () => {
    render(<MapPanner target={null} />)
    expect(panTo).not.toHaveBeenCalled()
  })

  /**
   * The regression this component exists for. Callers pass a fresh object
   * literal (`selected ? { lat: s.lat, lng: s.lng } : null`) on every
   * render, so keying on the object — or panning during render — makes each
   * pan trigger the map's own camera-changed handler, which stores the new
   * centre, which re-renders, which pans again. The map ends up pinned to
   * the selected stop and cannot be dragged or zoomed at all.
   */
  it('does not re-pan when re-rendered with an equal but newly-allocated target', () => {
    const { rerender } = render(<MapPanner target={{ lat: 59.91, lng: 10.75 }} />)
    expect(panTo).toHaveBeenCalledTimes(1)

    rerender(<MapPanner target={{ lat: 59.91, lng: 10.75 }} />)
    rerender(<MapPanner target={{ lat: 59.91, lng: 10.75 }} />)

    expect(panTo).toHaveBeenCalledTimes(1)
  })

  it('pans again when the selection actually moves', () => {
    const { rerender } = render(<MapPanner target={{ lat: 59.91, lng: 10.75 }} />)
    rerender(<MapPanner target={{ lat: 60.39, lng: 5.32 }} />)

    expect(panTo).toHaveBeenCalledTimes(2)
    expect(panTo).toHaveBeenLastCalledWith({ lat: 60.39, lng: 5.32 })
  })
})
