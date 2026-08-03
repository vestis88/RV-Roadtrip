import { useMemo, useState } from 'react'
import {
  APIProvider,
  AdvancedMarker,
  Map as GoogleMap,
} from '@vis.gl/react-google-maps'
import type { LatLng, NamedPoint, SharedTripStop } from '@rv/shared'
import { DirectionsRoute } from './DirectionsRoute'
import { FitToPoints } from './FitToPoints'
import { isoCountryFlag } from '../lib/countryFlag'

/**
 * A point the traveler never filled in comes back as an empty name at
 * (0, 0), which is a spot in the Atlantic — drawing it would put the whole
 * map in the Gulf of Guinea and the real route in a corner. Same guard as
 * validateRoute's isLocated, for the same reason.
 */
function isLocated(point: NamedPoint): boolean {
  return point.name.trim() !== '' && !(point.lat === 0 && point.lng === 0)
}

/**
 * The route as a map, for relatives following along from home.
 *
 * Read-only in the strong sense the rest of this page is: no marker does
 * anything when tapped, and Google's own controls are off, so the page keeps
 * its "zero buttons" property rather than sprouting a fullscreen and a
 * Street View pegman that lead somewhere else.
 *
 * Its own APIProvider because this screen renders outside AppShell, which is
 * where the app's single Maps loader normally lives — the two never mount
 * together, so there is no repeat of the racing-loader problem that
 * hoisting solved.
 */
export function SharedTripMap({
  stops,
  startPoint,
  endPoint,
}: {
  stops: SharedTripStop[]
  startPoint: NamedPoint
  endPoint: NamedPoint
}) {
  const [routeError, setRouteError] = useState<string | null>(null)
  const apiKey = import.meta.env.VITE_GOOGLE_MAPS_API_KEY as string | undefined

  const points = useMemo<LatLng[]>(() => {
    const ordered: LatLng[] = []
    if (isLocated(startPoint)) ordered.push({ lat: startPoint.lat, lng: startPoint.lng })
    for (const stop of stops) ordered.push({ lat: stop.lat, lng: stop.lng })
    if (isLocated(endPoint)) ordered.push({ lat: endPoint.lat, lng: endPoint.lng })
    return ordered
  }, [stops, startPoint, endPoint])

  if (points.length === 0) return null

  if (!apiKey) {
    return (
      <section className="card p-4" data-testid="shared-map-unavailable">
        <p className="text-sm text-neutral-500 dark:text-neutral-400">
          The map isn&apos;t available right now — the route is listed below.
        </p>
      </section>
    )
  }

  return (
    <section className="card overflow-hidden" data-testid="shared-map">
      <div className="h-72 w-full sm:h-96">
        <APIProvider apiKey={apiKey}>
          <GoogleMap
            defaultCenter={points[0]}
            defaultZoom={6}
            mapId="rv-trip-shared"
            gestureHandling="greedy"
            disableDefaultUI
          >
            <FitToPoints points={points} />
            <DirectionsRoute points={points} onError={setRouteError} />

            {isLocated(startPoint) && (
              <AdvancedMarker
                position={{ lat: startPoint.lat, lng: startPoint.lng }}
                title={`Start: ${startPoint.name}`}
              />
            )}
            {stops.map((stop, index) => (
              <AdvancedMarker
                key={stop.id}
                position={{ lat: stop.lat, lng: stop.lng }}
                title={`${stop.name} ${stop.country ? isoCountryFlag(stop.country) : ''}`.trim()}
                data-testid={`shared-map-stop-${stop.id}`}
              >
                <div className="flex h-7 min-w-7 items-center justify-center rounded-full border-2 border-white bg-emerald-700 px-2 text-xs font-semibold text-white shadow-md dark:border-neutral-900">
                  {index + 1}
                </div>
              </AdvancedMarker>
            ))}
            {isLocated(endPoint) && (
              <AdvancedMarker
                position={{ lat: endPoint.lat, lng: endPoint.lng }}
                title={`Finish: ${endPoint.name}`}
              />
            )}
          </GoogleMap>
        </APIProvider>
      </div>
      {routeError && (
        // Same reasoning as the in-app maps: a straight-line fallback is
        // still drawn, and saying why beats a silently wrong-looking shape.
        <p
          className="px-4 py-2 text-xs text-neutral-500 dark:text-neutral-400"
          data-testid="shared-map-route-error"
        >
          Showing approximate straight lines — the driving route couldn&apos;t be
          loaded ({routeError}).
        </p>
      )}
    </section>
  )
}
