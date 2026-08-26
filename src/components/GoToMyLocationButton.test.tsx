import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'

const moveCamera = vi.fn()
const mapStub = {
  moveCamera,
  getDiv: () => ({ offsetWidth: 390 }) as unknown as HTMLDivElement,
}
let currentMap: unknown = mapStub
vi.mock('@vis.gl/react-google-maps', () => ({
  useMap: () => currentMap,
}))

const { GoToMyLocationButton, MY_LOCATION_SPAN_KM } = await import(
  './GoToMyLocationButton'
)

const HERE = { lat: 46.49, lng: 11.34 }

/**
 * Requested 2026-08-25: "I want a button to go to my location. Then the zoom
 * could be like 5 km."
 *
 * Unit-tested rather than driven through Playwright because it needs a live
 * Google map to do anything at all — `useMap` returns null without one, and
 * the CI browser has no Maps key. Same split MarkerBadge already uses: the
 * behaviour here, the presence on screen in e2e.
 */
describe('going back to my location', () => {
  function renderButton(
    props: Partial<Parameters<typeof GoToMyLocationButton>[0]> = {},
  ) {
    return render(
      <GoToMyLocationButton
        mapId="explore-map"
        position={HERE}
        denied={false}
        {...props}
      />,
    )
  }

  it('centres the map on where we are', () => {
    currentMap = mapStub
    moveCamera.mockClear()
    renderButton()
    fireEvent.click(screen.getByTestId('go-to-my-location'))

    expect(moveCamera).toHaveBeenCalledTimes(1)
    expect(moveCamera.mock.calls[0][0].center).toEqual(HERE)
  })

  /**
   * Closer than the opening view on purpose: opening wide answers "where am
   * I in this trip", pressing this answers "what is around me right now".
   * Asserted as the ground it covers rather than as a zoom number, since the
   * number is only right if the span is.
   */
  it('zooms to about five kilometres across', () => {
    currentMap = mapStub
    moveCamera.mockClear()
    renderButton()
    fireEvent.click(screen.getByTestId('go-to-my-location'))

    const { zoom } = moveCamera.mock.calls[0][0]
    const metresPerPixel =
      (156_543.03392 * Math.cos((HERE.lat * Math.PI) / 180)) / 2 ** zoom
    expect((metresPerPixel * 390) / 1000).toBeCloseTo(MY_LOCATION_SPAN_KM, 5)
  })

  it('waits rather than doing nothing visible before the first fix', () => {
    currentMap = mapStub
    renderButton({ position: null })
    expect(
      (screen.getByTestId('go-to-my-location') as HTMLButtonElement).disabled,
    ).toBe(true)
  })

  // Someone who said no to the prompt has answered the question. A
  // permanently dead control is worse than no control.
  it('is not offered at all once location is refused', () => {
    currentMap = mapStub
    renderButton({ denied: true })
    expect(screen.queryByTestId('go-to-my-location')).toBeNull()
  })

  // No Maps key, no map — which is exactly the state the e2e browser is in.
  it('stays inert without a map to move', () => {
    currentMap = null
    moveCamera.mockClear()
    renderButton()
    const button = screen.getByTestId('go-to-my-location') as HTMLButtonElement
    expect(button.disabled).toBe(true)
    fireEvent.click(button)
    expect(moveCamera).not.toHaveBeenCalled()
  })
})
