import { describe, expect, it } from 'vitest'
import { zoomForSpanKm } from './mapZoom'

/**
 * Requested 2026-08-25: "Make this gps location at like 50 km edge to edge on
 * screen."
 *
 * Asserted by measuring the ground the resulting zoom actually covers rather
 * than by pinning a magic number — the number is only right if the span is.
 */
function spanKmAt(zoom: number, viewportPx: number, lat: number): number {
  const metresPerPixel =
    (156_543.03392 * Math.cos((lat * Math.PI) / 180)) / 2 ** zoom
  return (metresPerPixel * viewportPx) / 1000
}

describe('zoom for a span', () => {
  it('puts 50 km across a phone screen', () => {
    const zoom = zoomForSpanKm({ spanKm: 50, viewportPx: 390, lat: 47 })
    expect(spanKmAt(zoom, 390, 47)).toBeCloseTo(50, 5)
  })

  it('puts 50 km across a tablet screen too', () => {
    const zoom = zoomForSpanKm({ spanKm: 50, viewportPx: 1180, lat: 47 })
    expect(spanKmAt(zoom, 1180, 47)).toBeCloseTo(50, 5)
    // A wider screen showing the same ground has to be zoomed further in.
    expect(zoom).toBeGreaterThan(
      zoomForSpanKm({ spanKm: 50, viewportPx: 390, lat: 47 }),
    )
  })

  /**
   * The cosine is the point: the same zoom covers about a third less ground
   * in northern Norway than at the Mediterranean, so a fixed number would
   * mean "50 km" only somewhere in between.
   */
  it('holds the span at any latitude', () => {
    for (const lat of [0, 47, 69]) {
      const zoom = zoomForSpanKm({ spanKm: 50, viewportPx: 390, lat })
      expect(spanKmAt(zoom, 390, lat), `at ${lat}°`).toBeCloseTo(50, 5)
    }
  })

  it('stays inside the zoom levels Google has', () => {
    expect(zoomForSpanKm({ spanKm: 40_000, viewportPx: 390, lat: 0 })).toBe(1)
    expect(zoomForSpanKm({ spanKm: 0.001, viewportPx: 390, lat: 0 })).toBe(20)
  })

  // A map element that has not been laid out yet reports zero width.
  it('degrades rather than returning nonsense', () => {
    expect(zoomForSpanKm({ spanKm: 50, viewportPx: 0, lat: 47 })).toBe(1)
    expect(zoomForSpanKm({ spanKm: 0, viewportPx: 390, lat: 47 })).toBe(1)
  })
})
