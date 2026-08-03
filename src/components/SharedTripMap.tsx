import { useState } from 'react'
import {
  APIProvider,
  AdvancedMarker,
  Map as GoogleMap,
} from '@vis.gl/react-google-maps'
import type { NamedPoint, SharedTripStop } from '@rv/shared'
import { DirectionsRoute } from './DirectionsRoute'
import { FitToPoints } from './FitToPoints'
import { isoCountryFlag } from '../lib/countryFlag'
import { isLocated, sharedRoutePoints } from '../lib/sharedRoutePoints'

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
 *
 * The section keeps its testid whether or not a Maps key is configured. The
 * two are genuinely the same thing to a reader — "here is where the route
 * is" — and making the identity depend on the environment is what let an
 * e2e assertion pass locally and fail on CI, where the build has no key.
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
  const points = sharedRoutePoints(stops, startPoint, endPoint)

  if (points.length === 0) return null

  return (
    <section className="card overflow-hidden" data-testid="shared-map">
      {apiKey ? (
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
      ) : (
        <p
          className="p-4 text-sm text-neutral-500 dark:text-neutral-400"
          data-testid="shared-map-unavailable"
        >
          The map isn&apos;t available right now — the route is listed below.
        </p>
      )}
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
