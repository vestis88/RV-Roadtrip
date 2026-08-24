import { useEffect, useState } from 'react'

/**
 * Where we are, for drawing.
 *
 * Requested 2026-08-23: "Right now I can't see my position on the map. This
 * should be added."
 *
 * The fix was already being taken — `useExecutionMode` asks for one every
 * thirty minutes to measure drift against the plan — but it was only ever
 * MEASURED, never drawn. This is the same reading, on its own, for anything
 * that wants to show it.
 *
 * Two differences from that poll, both deliberate:
 *
 *  - It runs whenever something is watching, not only while today falls
 *    inside the trip's dates. Looking at the map before you leave and seeing
 *    yourself at home is useful; seeing nothing is confusing.
 *  - It watches rather than samples. A marker that lags half an hour behind
 *    the van is worse than none, and `watchPosition` costs nothing extra
 *    once permission is granted.
 *
 * Denial is not an error. Someone who says no to the prompt has answered the
 * question, and the map simply carries on without a marker rather than
 * nagging or showing a failure they cannot act on.
 */
export interface CurrentPosition {
  lat: number
  lng: number
  /** Metres of uncertainty, as the browser reports it. */
  accuracy?: number
}

export function useCurrentPosition(enabled = true): {
  position: CurrentPosition | null
  denied: boolean
} {
  const [position, setPosition] = useState<CurrentPosition | null>(null)
  const [denied, setDenied] = useState(false)

  useEffect(() => {
    if (!enabled) return
    if (typeof navigator === 'undefined' || !navigator.geolocation) return
    // Held rather than re-read on cleanup. `navigator` is a global that can
    // be swapped underneath a mounted component — a test stub, a polyfill —
    // and clearing a watch on a DIFFERENT object than the one that created
    // it either throws or silently leaks the watch.
    const geolocation = navigator.geolocation

    const id = geolocation.watchPosition(
      (fix) => {
        setDenied(false)
        setPosition({
          lat: fix.coords.latitude,
          lng: fix.coords.longitude,
          accuracy: fix.coords.accuracy,
        })
      },
      (error) => {
        // Only a refusal is worth remembering. A timeout or a lost fix is
        // temporary and the watch keeps trying; treating those as denial
        // would hide the marker for the rest of the session.
        if (error.code === error.PERMISSION_DENIED) setDenied(true)
      },
      { enableHighAccuracy: false, maximumAge: 60_000, timeout: 20_000 },
    )
    return () => geolocation.clearWatch(id)
  }, [enabled])

  return { position, denied }
}
