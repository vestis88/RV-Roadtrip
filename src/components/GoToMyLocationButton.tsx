import { useMap } from '@vis.gl/react-google-maps'
import { zoomForSpanKm } from '../lib/mapZoom'

/**
 * "Take me back to where I am."
 *
 * Requested 2026-08-25: "I want a button to go to my location. Then the zoom
 * could be like 5 km."
 *
 * The map already opens on the traveler's position (MapOpeningView), but
 * deliberately only ONCE — a GPS watch reports a fix every few seconds and
 * re-centring on each would drag the map out from under anyone looking
 * somewhere else. That leaves no way back after a pan, which is what this is.
 *
 * Closer than the opening view on purpose. Opening wide answers "where am I
 * in this trip"; pressing this answers "what is around me right now", and 5
 * km is about the next twenty minutes of driving rather than the next two
 * hours.
 *
 * It reaches the map by id through `useMap` rather than being a child of it:
 * the map's overlay controls are positioned siblings of the `<Map>` element,
 * not markers inside it, and the whole screen sits under one APIProvider.
 */
export const MY_LOCATION_SPAN_KM = 5

export function GoToMyLocationButton({
  mapId,
  position,
  denied,
}: {
  mapId: string
  position: { lat: number; lng: number } | null
  /** Permission was refused — an answer, not an error. */
  denied: boolean
}) {
  const map = useMap(mapId)

  // Nothing to go to, and nothing that will ever come. Someone who said no
  // to the prompt has answered the question; a permanently dead button is
  // worse than no button.
  if (denied) return null

  return (
    <button
      type="button"
      data-testid="go-to-my-location"
      // Disabled rather than hidden while waiting for the first fix, so it
      // does not appear from nowhere a second after the map does.
      disabled={!map || !position}
      title={position ? 'Centre on where we are' : 'Waiting for your location'}
      aria-label="Centre the map on where we are"
      className="btn btn-sm border border-neutral-300 bg-white/95 text-neutral-700 shadow-md backdrop-blur-sm hover:bg-neutral-100 disabled:opacity-40 dark:border-neutral-600 dark:bg-neutral-900/95 dark:text-neutral-100 dark:hover:bg-neutral-800"
      onClick={() => {
        if (!map || !position) return
        map.moveCamera({
          center: { lat: position.lat, lng: position.lng },
          zoom: zoomForSpanKm({
            spanKm: MY_LOCATION_SPAN_KM,
            // The real element, so the span is right on a phone and on a
            // tablet — see zoomForSpanKm.
            viewportPx: map.getDiv()?.offsetWidth ?? 0,
            lat: position.lat,
          }),
        })
      }}
    >
      Where we are
    </button>
  )
}
