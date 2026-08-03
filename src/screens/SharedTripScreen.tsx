import { useEffect } from 'react'
import { useParams } from 'react-router-dom'
import type { Meal, SharedTripDay, SharedTripPlace } from '@rv/shared'
import { CardRow } from '../components/CardRow'
import { PlaceCard } from '../components/PlaceCard'
import { SharedTripMap } from '../components/SharedTripMap'
import { useSharedTripView } from '../hooks/useSharedTripView'
import { isoCountryFlag } from '../lib/countryFlag'
import { SHARED_TRIP_POLL_MS } from '../lib/sharedTripView'

const MEAL_TITLES: { meal: Meal; title: string }[] = [
  { meal: 'breakfast', title: 'Breakfast' },
  { meal: 'lunch', title: 'Lunch' },
  { meal: 'dinner', title: 'Dinner' },
]

/**
 * PlaceCard renders its Select/Done/Skip row only when handed the matching
 * callbacks, so passing none is a genuinely read-only card rather than a
 * disabled-looking editable one — the guest page must not contain a control
 * that could ever write to someone else's trip.
 */
function SharedPlaceRow({
  title,
  testId,
  places,
}: {
  title: string
  testId: string
  places: SharedTripPlace[]
}) {
  if (places.length === 0) return null
  return (
    <CardRow title={title} testId={testId}>
      {places.map((place) => (
        <PlaceCard
          key={place.id}
          testId={`${testId}-${place.id}`}
          name={place.name}
          category={place.category}
          rating={place.rating}
          ratingCount={place.ratingCount}
          blurb={place.blurb}
          photoUrl={place.photoUrl}
          googleMapsUrl={place.googleMapsUrl}
        />
      ))}
    </CardRow>
  )
}

function SharedDayCard({ day }: { day: SharedTripDay }) {
  return (
    <article className="card overflow-hidden pb-3" data-testid="shared-day">
      <div className="px-4 pt-3">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h3
            className="text-base font-semibold tracking-tight text-neutral-900 dark:text-white"
            data-testid="shared-day-heading"
          >
            Day {day.index + 1} — {day.date}
          </h3>
          {day.type === 'rest' && (
            <span className="chip chip-amber">Rest day</span>
          )}
        </div>

        <p className="mt-1 text-sm leading-relaxed text-neutral-600 dark:text-neutral-300">
          {day.summary}
        </p>

        {day.highlightReason && (
          <p className="mt-2 rounded-lg bg-orange-50 px-3 py-2 text-sm text-orange-900 italic dark:bg-orange-950 dark:text-orange-200">
            Why here: {day.highlightReason}
          </p>
        )}

        <p className="mt-2 text-sm text-neutral-700 dark:text-neutral-200">
          Overnight:{' '}
          <span className="font-medium">{day.overnight.name}</span>{' '}
          {isoCountryFlag(day.overnight.country)}
        </p>

        {day.drive && (
          <div className="mt-2 text-sm text-neutral-700 dark:text-neutral-200">
            <p className="font-medium">
              {day.drive.fromName} → {day.drive.toName}
            </p>
            <div className="mt-1 flex flex-wrap items-center gap-1.5">
              <span className="chip chip-neutral">
                {day.drive.distanceKm.toFixed(0)} km
              </span>
              <span className="chip chip-neutral">
                {day.drive.durationMin.toFixed(0)} min
              </span>
            </div>
          </div>
        )}
      </div>

      <SharedPlaceRow
        title="Activities"
        testId={`shared-activities-${day.id}`}
        places={day.activities}
      />
      {MEAL_TITLES.map(({ meal, title }) => (
        <SharedPlaceRow
          key={meal}
          title={title}
          testId={`shared-${meal}-${day.id}`}
          places={day.restaurants.filter((place) => place.meal === meal)}
        />
      ))}
    </article>
  )
}

/**
 * The guest half of family sharing: rendered outside AppShell, so it has no
 * trip context, no useTripSession and — the point of the whole feature — no
 * sign-in. Everything on screen comes from one HTTPS endpoint keyed by the
 * link's own token, and nothing on screen can write anything back.
 */
export function SharedTripScreen() {
  const { token } = useParams<{ token: string }>()
  const { view, status } = useSharedTripView(token)

  useEffect(() => {
    document.title = view?.trip.name
      ? `${view.trip.name} · Follow along`
      : 'Follow along · RV Road Trip Planner'
  }, [view?.trip.name])

  if (status === 'loading') {
    return (
      <main className="surface flex min-h-svh items-center justify-center p-6">
        <p
          className="text-neutral-500 dark:text-neutral-400"
          data-testid="shared-trip-loading"
        >
          Loading the trip…
        </p>
      </main>
    )
  }

  if (status === 'not-found' || !view) {
    return (
      <main className="surface flex min-h-svh items-center justify-center p-6">
        <div className="max-w-md text-center" data-testid="shared-trip-missing">
          <h1 className="heading-md">This link isn't available</h1>
          <p className="mt-2 text-neutral-500 dark:text-neutral-400">
            It may have been withdrawn by the travelers, or the address may be
            mistyped. Ask them for a fresh link.
          </p>
        </div>
      </main>
    )
  }

  const { trip, days, corridorStops, diary } = view
  // Committed stops are the route as planned and locked ones are stops the
  // travelers have decided on; 'proposed'/'candidate' stops are suggestions
  // they haven't answered yet, which would read to family as part of the
  // plan when they are not.
  const routeStops = corridorStops.filter(
    (stop) => stop.status === 'committed' || stop.status === 'locked',
  )

  return (
    <main className="surface min-h-svh" data-testid="shared-trip-view">
      <header className="border-b border-neutral-200 bg-white px-4 py-6 text-center dark:border-neutral-800 dark:bg-neutral-900">
        <p className="chip chip-accent">Follow along · view only</p>
        <h1 className="heading-lg mt-2" data-testid="shared-trip-name">
          {trip.name || 'Our road trip'}
        </h1>
        <p
          className="mt-1 text-sm text-neutral-500 dark:text-neutral-400"
          data-testid="shared-trip-dates"
        >
          {trip.startDate} → {trip.endDate}
        </p>
        {(trip.startPoint.name || trip.endPoint.name) && (
          <p className="mt-1 text-sm text-neutral-500 dark:text-neutral-400">
            {trip.startPoint.name} → {trip.endPoint.name}
          </p>
        )}
        <div className="mt-3 flex flex-wrap items-center justify-center gap-1.5">
          <span className="chip chip-neutral" data-testid="shared-day-count">
            {days.length} days
          </span>
          {trip.totalKm != null && (
            <span className="chip chip-neutral">{trip.totalKm.toFixed(0)} km</span>
          )}
          {trip.avgDriveMinutesPerDay != null && (
            <span className="chip chip-neutral">
              {trip.avgDriveMinutesPerDay.toFixed(0)} min/day avg
            </span>
          )}
        </div>
      </header>

      <div className="mx-auto max-w-2xl space-y-4 p-4 text-left">
        <SharedTripMap
          stops={routeStops}
          startPoint={trip.startPoint}
          endPoint={trip.endPoint}
        />

        {routeStops.length > 0 && (
          <section className="card p-4" data-testid="shared-route">
            <h2 className="heading-md text-lg">The route</h2>
            <ol className="mt-2 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-sm text-neutral-700 dark:text-neutral-200">
              {routeStops.map((stop, index) => (
                <li key={stop.id} data-testid="shared-route-stop">
                  {index > 0 && <span aria-hidden> · </span>}
                  {stop.name}
                  {stop.country ? ` ${isoCountryFlag(stop.country)}` : ''}
                </li>
              ))}
            </ol>
          </section>
        )}

        <section className="space-y-4">
          <h2 className="heading-md text-lg">Day by day</h2>
          {days.length === 0 ? (
            <p
              className="text-neutral-500 dark:text-neutral-400"
              data-testid="shared-days-empty"
            >
              The travelers haven't planned any days yet.
            </p>
          ) : (
            days.map((day) => <SharedDayCard key={day.id} day={day} />)
          )}
        </section>

        <section data-testid="shared-diary">
          <h2 className="heading-md text-lg">Diary</h2>
          {diary.length === 0 ? (
            <p
              className="mt-2 text-neutral-500 dark:text-neutral-400"
              data-testid="shared-diary-empty"
            >
              Nothing logged yet — entries appear here as the trip happens.
            </p>
          ) : (
            <ul className="mt-2 space-y-2">
              {diary.map((entry) => (
                <li
                  key={entry.id}
                  className="card p-3"
                  data-testid="shared-diary-entry"
                >
                  <p className="text-sm font-semibold text-neutral-900 dark:text-white">
                    {entry.placeName}
                  </p>
                  <p className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-neutral-500 dark:text-neutral-400">
                    <span>{entry.date}</span>
                    <span className="chip chip-neutral">{entry.refType}</span>
                  </p>
                  {entry.note && (
                    <p
                      className="mt-1 text-sm text-neutral-700 dark:text-neutral-300"
                      data-testid="shared-diary-note"
                    >
                      {entry.note}
                    </p>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>

        <p
          className="pb-6 text-center text-xs text-neutral-500 dark:text-neutral-400"
          data-testid="shared-trip-freshness"
        >
          This page refreshes itself every {Math.round(SHARED_TRIP_POLL_MS / 1000)}{' '}
          seconds — no need to reload. Last updated{' '}
          {new Date(view.fetchedAt).toLocaleTimeString()}.
        </p>
      </div>
    </main>
  )
}

export default SharedTripScreen
