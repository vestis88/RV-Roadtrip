import { useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import {
  AdvancedMarker,
  Map as GoogleMap,
} from '@vis.gl/react-google-maps'
import type { ActivityTimeOfDay, Meal } from '@rv/shared'
import { useTripContext } from '../context/TripContext'
import { useTripDays } from '../hooks/useTripDays'
import { useCorridorStops } from '../hooks/useCorridorStops'
import { dayHeaderPhotos } from '../lib/dayHeaderPhoto'
import { useDayDetail, type ActivityWithId, type RestaurantWithId } from '../hooks/useDayDetail'
import { DayDetailGate } from '../components/DayDetailGate'
import { fillDaySection } from '../lib/dayDetailAction'
import { buildDayRoutePoints } from '../lib/buildOverviewRoute'
import { CardRow } from '../components/CardRow'
import { FitToPoints } from '../components/FitToPoints'
import { DirectionsRoute } from '../components/DirectionsRoute'
import { MapPanner } from '../components/MapPanner'
import { PlaceCard } from '../components/PlaceCard'
import { AddCustomStopForm } from '../components/AddCustomStopForm'
import { RequestChangesForDay } from '../components/RequestChangesForDay'
import { AddRestDay } from '../components/AddRestDay'
import { PlanBusyBanner } from '../components/PlanBusyBanner'
import { usePlanBusy } from '../lib/planBusy'
import { OvernightCandidatesPicker } from '../components/OvernightCandidatesPicker'
import { MarkerBadge } from '../components/MarkerBadge'
import { CATEGORY_ICON, OVERNIGHT_ICON, RESTAURANT_ICON } from '../lib/mapIcons'
import { navigateUrl } from '../lib/mapLinks'
import {
  markDone,
  markSuggested,
  selectAndRequeue,
  setActivityTimeOfDay,
  skipAndRequeue,
  type PlaceKind,
  type RequeueResult,
} from '../lib/placeStatus'

interface SelectedPlace {
  id: string
  name: string
  lat: number
  lng: number
}

interface IndexedPlace {
  index: number
  place: ActivityWithId | RestaurantWithId
}

/**
 * One CardRow's worth of activity/restaurant options. A skipped item used to
 * just sit in place with a dimmer label — reported as "skipping does not
 * remove the card and reveal a new one" — so it's tucked behind a "Show
 * skipped" toggle instead: gone from the main scroller by default (clearing
 * room for whatever else was generated for this slot), reversible by
 * expanding the toggle and tapping Select again rather than lost outright.
 */
const REQUEUE_MESSAGE: Record<RequeueResult, string | null> = {
  no_action: null,
  requeued: null,
  researched: 'Found more options nearby.',
  exhausted: 'No more nearby options found.',
}

function PlaceCardSection({
  title,
  rowTestId,
  cardIdPrefix,
  kind,
  meal,
  entries,
  tripId,
  dayId,
  date,
  selectedPlaceId,
  onSelect,
}: {
  title: string
  rowTestId: string
  cardIdPrefix: string
  kind: PlaceKind
  meal?: Meal
  entries: IndexedPlace[]
  tripId: string
  dayId: string
  date: string
  selectedPlaceId: string | undefined
  onSelect: (cardId: string, place: { name: string; lat: number; lng: number }) => void
}) {
  const [showSkipped, setShowSkipped] = useState(false)
  const [requeuing, setRequeuing] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const active = entries.filter(({ place }) => place.status !== 'skipped')
  const skipped = entries.filter(({ place }) => place.status === 'skipped')
  const visible = showSkipped ? [...active, ...skipped] : active

  // Skip and select trigger the same underlying cascade (see
  // skipAndRequeue/selectAndRequeue's own doc comments in placeStatus.ts)
  // but with different thresholds: skip always tries to bring in one
  // replacement, since skipping means "not interested, show me something
  // else"; select only refills once the whole scope's live-suggested pool
  // is drained, since selecting means "keeping this one" and several items
  // can be selected at once (no "only one" rule anywhere here). Reverting a
  // selection back to suggested (see onToggleSelected below) only grows the
  // pool, so it never needs either check.
  async function advance(placeId: string, action: 'select' | 'skip') {
    setRequeuing(true)
    setNotice(null)
    try {
      const requeue = action === 'select' ? selectAndRequeue : skipAndRequeue
      const result = await requeue(tripId, dayId, kind, placeId, meal)
      setNotice(REQUEUE_MESSAGE[result])
    } catch (error) {
      console.error(`${action}AndRequeue failed`, error)
      setNotice('Could not find more options right now.')
    } finally {
      setRequeuing(false)
    }
  }

  /**
   * Filling this one section, because someone asked for this one section.
   *
   * Requested 2026-08-25. Offered only when the section is EMPTY: once there
   * are cards here, "skip" and "select" already bring in replacements one at
   * a time, and a button that replaced the lot would undo choices rather
   * than add to them.
   */
  const [filling, setFilling] = useState(false)
  const [fillError, setFillError] = useState<string | null>(null)
  const isEmpty = entries.length === 0

  async function fill() {
    setFilling(true)
    setFillError(null)
    try {
      await fillDaySection(tripId, dayId, kind, meal)
    } catch (error) {
      console.error('fillDaySection failed', error)
      setFillError('Could not fill that in — please try again.')
    } finally {
      setFilling(false)
    }
  }

  return (
    <CardRow
      title={title}
      testId={rowTestId}
      empty={
        isEmpty ? (
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              data-testid={`${rowTestId}-fill`}
              className="btn btn-sm btn-secondary disabled:opacity-40"
              disabled={filling}
              onClick={() => void fill()}
            >
              {filling
                ? 'Finding…'
                : kind === 'activity'
                  ? 'Find things to do'
                  : `Find ${meal}`}
            </button>
            {fillError && (
              <span
                data-testid={`${rowTestId}-fill-error`}
                className="text-xs text-red-600 dark:text-red-400"
              >
                {fillError}
              </span>
            )}
          </div>
        ) : undefined
      }
      footer={
        skipped.length > 0 || requeuing || notice ? (
          <span className="flex flex-wrap items-center gap-2">
            {skipped.length > 0 && (
              <button
                type="button"
                data-testid={`${rowTestId}-show-skipped`}
                onClick={() => setShowSkipped((v) => !v)}
                className="text-xs text-neutral-500 underline underline-offset-2 dark:text-neutral-400"
              >
                {showSkipped ? 'Hide' : 'Show'} {skipped.length} skipped
              </button>
            )}
            {requeuing && (
              <span
                data-testid={`${rowTestId}-researching`}
                className="text-xs text-neutral-500 dark:text-neutral-400"
              >
                Looking for more options…
              </span>
            )}
            {!requeuing && notice && (
              <span
                data-testid={`${rowTestId}-requeue-notice`}
                className="text-xs text-neutral-500 dark:text-neutral-400"
              >
                {notice}
              </span>
            )}
          </span>
        ) : undefined
      }
    >
      {visible.map(({ index, place }) => {
        const cardId = `${cardIdPrefix}-card-${index}`
        return (
          <div
            key={index}
            className={place.status === 'skipped' ? 'opacity-60' : undefined}
          >
            <PlaceCard
              testId={cardId}
              name={place.name}
              category={'category' in place ? place.category : undefined}
              rating={place.rating}
              ratingCount={place.ratingCount}
              blurb={place.blurb}
              substitute={place.substitute}
              photoUrl={place.photoUrl}
              googleMapsUrl={place.googleMapsUrl}
              status={place.status}
              // A requeue for this scope is already running — see PlaceCard's
              // own `busy` doc comment for why a second tap is costly.
              busy={requeuing}
              selected={selectedPlaceId === cardId}
              onTap={() =>
                onSelect(cardId, {
                  name: place.name,
                  lat: place.lat,
                  lng: place.lng,
                })
              }
              onToggleSelected={() => {
                if (place.status === 'selected') {
                  markSuggested(tripId, dayId, kind, place.id).catch(console.error)
                } else {
                  advance(place.id, 'select').catch(console.error)
                }
              }}
              onMarkDone={(note) =>
                markDone(tripId, dayId, kind, place.id, date, note).catch(
                  console.error,
                )
              }
              onMarkSkipped={() => {
                advance(place.id, 'skip').catch(console.error)
              }}
              timeOfDay={
                kind === 'activity' && 'timeOfDay' in place
                  ? place.timeOfDay
                  : undefined
              }
              onSetTimeOfDay={
                kind === 'activity'
                  ? (timeOfDay: ActivityTimeOfDay) =>
                      setActivityTimeOfDay(tripId, dayId, place.id, timeOfDay).catch(
                        console.error,
                      )
                  : undefined
              }
            />
          </div>
        )
      })}
    </CardRow>
  )
}

export function DayViewScreen() {
  const { tripId, trip } = useTripContext()
  const navigate = useNavigate()
  const { dayId } = useParams<{ dayId: string }>()
  const { days } = useTripDays(tripId)
  const { corridorStops } = useCorridorStops(tripId)
  const { day, activities, restaurants, loading } = useDayDetail(tripId, dayId)
  const [selectedPlace, setSelectedPlace] = useState<SelectedPlace | null>(null)
  const [routeError, setRouteError] = useState<string | null>(null)
  // Day View is where both structural actions live, and it was the one
  // screen that never showed whether the plan was being rewritten.
  const { busy: planBusy, markSubmitted } = usePlanBusy(trip.planMeta.status)

  // The map doesn't remount just because the /map/day/:dayId route param
  // changed (same route element, reused across Prev/Next) — without this, a
  // marker/card focused on the previous day left its pan/zoom and "Showing:
  // X" caption sitting on screen after navigating to a new day, with that
  // day's own pins now off-screen. Reset synchronously during render
  // (React's documented "adjusting state when a prop changes" pattern)
  // rather than in an effect, so the stale caption is never shown even for
  // one frame.
  const [lastDayId, setLastDayId] = useState(dayId)
  if (lastDayId !== dayId) {
    setLastDayId(dayId)
    setSelectedPlace(null)
  }

  const framedPoints = useMemo(
    () =>
      day
        ? [
            { lat: day.overnight.lat, lng: day.overnight.lng },
            ...activities.map((a) => ({ lat: a.lat, lng: a.lng })),
            ...restaurants.map((r) => ({ lat: r.lat, lng: r.lng })),
          ]
        : [],
    [day, activities, restaurants],
  )

  // Always shown, not just on the overview map — routing through a day's
  // meals/activities used to only exist as text (the drive card below), with
  // the day map itself drawing markers only, no route line at all.
  const routePoints = useMemo(
    () =>
      day
        ? buildDayRoutePoints({
            overnight: day.overnight,
            driveSlot: day.drive?.slot,
            activities,
            restaurants,
          })
        : [],
    [day, activities, restaurants],
  )

  const dayIndex = days.findIndex((d) => d.id === dayId)
  const prevDayId = dayIndex > 0 ? days[dayIndex - 1].id : undefined
  const nextDayId =
    dayIndex >= 0 && dayIndex < days.length - 1
      ? days[dayIndex + 1].id
      : undefined

  function goToDay(id: string | undefined) {
    if (id) navigate(`/map/day/${id}`)
  }

  const apiKey = import.meta.env.VITE_GOOGLE_MAPS_API_KEY as string | undefined

  if (loading || !day || !dayId) {
    return (
      <p className="p-4 text-neutral-500 dark:text-neutral-400">Loading day…</p>
    )
  }

  const detailGate = (
    <DayDetailGate tripId={tripId} dayId={dayId} day={day} />
  )

  const headerPhotos = dayHeaderPhotos(dayId, day.overnight.name, corridorStops)

  const breakfast = restaurants.filter((r) => r.meal === 'breakfast')
  const lunch = restaurants.filter((r) => r.meal === 'lunch')
  const dinner = restaurants.filter((r) => r.meal === 'dinner')

  return (
    <div
      className="flex h-full w-full flex-col lg:flex-row"
      data-testid="day-view"
    >
      <div
        className="relative h-[45%] w-full shrink-0 lg:h-full lg:w-1/2"
        data-testid="day-map"
      >
        {apiKey ? (
          <GoogleMap
            defaultCenter={{ lat: day.overnight.lat, lng: day.overnight.lng }}
            defaultZoom={12}
            mapId="rv-day-view"
            gestureHandling="greedy"
          >
            <FitToPoints points={framedPoints} />
            <MapPanner target={selectedPlace} />
            <DirectionsRoute points={routePoints} onError={setRouteError} />

            <AdvancedMarker
              position={{ lat: day.overnight.lat, lng: day.overnight.lng }}
              title={day.overnight.name}
            >
              <MarkerBadge icon={OVERNIGHT_ICON} />
            </AdvancedMarker>

            {activities.map((activity, i) => {
              const placeId = `activity-card-${i}`
              return (
                <AdvancedMarker
                  key={`activity-${i}`}
                  position={{ lat: activity.lat, lng: activity.lng }}
                  title={activity.name}
                  onClick={() =>
                    setSelectedPlace({
                      id: placeId,
                      name: activity.name,
                      lat: activity.lat,
                      lng: activity.lng,
                    })
                  }
                >
                  <MarkerBadge
                    icon={CATEGORY_ICON[activity.category]}
                    selected={activity.status === 'selected'}
                    highlighted={selectedPlace?.id === placeId}
                  />
                </AdvancedMarker>
              )
            })}

            {restaurants.map((restaurant, i) => {
              const placeId = `${restaurant.meal}-card-${restaurants
                .filter((r) => r.meal === restaurant.meal)
                .indexOf(restaurant)}`
              return (
                <AdvancedMarker
                  key={`restaurant-${i}`}
                  position={{ lat: restaurant.lat, lng: restaurant.lng }}
                  title={restaurant.name}
                  onClick={() =>
                    setSelectedPlace({
                      id: placeId,
                      name: restaurant.name,
                      lat: restaurant.lat,
                      lng: restaurant.lng,
                    })
                  }
                >
                  <MarkerBadge
                    icon={RESTAURANT_ICON}
                    selected={restaurant.status === 'selected'}
                    highlighted={selectedPlace?.id === placeId}
                  />
                </AdvancedMarker>
              )
            })}
          </GoogleMap>
        ) : (
          <div className="flex h-full w-full items-center justify-center bg-neutral-200 p-4 text-center text-neutral-500 dark:bg-neutral-800">
            Set VITE_GOOGLE_MAPS_API_KEY to display the map.
          </div>
        )}
        {selectedPlace && (
          <p
            data-testid="map-selected-caption"
            className="absolute bottom-3 left-3 rounded-full bg-white/95 px-3 py-1.5 text-xs font-medium text-neutral-900 shadow-md backdrop-blur-sm dark:bg-neutral-900/95 dark:text-white"
          >
            Showing: {selectedPlace.name}
          </p>
        )}
        {routeError && (
          <p
            data-testid="day-route-error-banner"
            className="absolute top-3 left-3 max-w-[70%] rounded-lg bg-amber-50 px-3 py-1.5 text-xs text-amber-900 shadow-md dark:bg-amber-950 dark:text-amber-100"
          >
            Showing a straight line instead of the real route — the driving
            directions request failed ({routeError}).
          </p>
        )}
      </div>

      <div className="flex-1 overflow-y-auto bg-white text-left lg:w-1/2 dark:bg-neutral-900">
        {/* The picture the traveler has been looking at all week on the
          * planning list, requested 2026-08-31: "carry the overview pic from
          * planning in as a header picture for day view." No placeholder
          * when there is none — see dayHeaderPhoto for why an activity's
          * photo is not borrowed to fill the gap. */}
        {headerPhotos.length > 0 && (
          <div className="flex h-32 w-full gap-px" data-testid="day-header-photos">
            {headerPhotos.map((photo) => (
              <img
                key={photo.url}
                src={photo.url}
                alt={photo.name}
                title={photo.name}
                decoding="async"
                data-testid="day-header-photo"
                // Equal shares of the row, each cropped to fill: a day with
                // one place gets a full-width header, a day with three gets
                // three thirds. `min-w-0` because a flex child will not
                // shrink below its image's intrinsic width without it, and
                // the row would scroll instead of dividing.
                className="h-full min-w-0 flex-1 object-cover"
              />
            ))}
          </div>
        )}
        <div className="flex items-center justify-between gap-2 px-4 pt-3 pb-2">
          <button
            type="button"
            data-testid="prev-day"
            disabled={!prevDayId}
            onClick={() => goToDay(prevDayId)}
            className="btn btn-sm btn-ghost"
          >
            ← Prev
          </button>
          <h2
            className="text-center text-base font-semibold tracking-tight text-neutral-900 dark:text-white"
            data-testid="day-view-date"
          >
            Day {day.index + 1} — {day.date}
          </h2>
          <button
            type="button"
            data-testid="next-day"
            disabled={!nextDayId}
            onClick={() => goToDay(nextDayId)}
            className="btn btn-sm btn-ghost"
          >
            Next →
          </button>
        </div>

        <p className="px-4 text-sm leading-relaxed text-neutral-600 dark:text-neutral-300">
          {day.summary}
        </p>

        {(day.highlightReason ?? day.extraTimeReason) && (
          <p
            className="mx-4 mt-2 rounded-lg bg-orange-50 px-3 py-2 text-sm text-orange-900 italic dark:bg-orange-950 dark:text-orange-200"
            data-testid="day-highlight-reason"
          >
            Why here: {day.highlightReason ?? day.extraTimeReason}
          </p>
        )}

        <PlanBusyBanner planMeta={trip.planMeta} busy={planBusy} />

        <RequestChangesForDay
          tripId={tripId}
          trip={trip}
          dayId={dayId}
          dayNumber={day.index + 1}
          allDayIds={days.map((d) => d.id)}
          planBusy={planBusy}
          onSubmitted={markSubmitted}
        />

        <AddRestDay
          tripId={tripId}
          dayId={dayId}
          overnightName={day.overnight.name}
          planBusy={planBusy}
          onSubmitted={markSubmitted}
        />

        <OvernightCandidatesPicker
          tripId={tripId}
          trip={trip}
          dayId={dayId}
          day={day}
          priorDayIds={days.filter((d) => d.index < day.index).map((d) => d.id)}
          planBusy={planBusy}
          onSubmitted={markSubmitted}
        />

        <p className="mx-4 mt-4 flex flex-wrap items-center gap-1.5 text-sm text-neutral-700 dark:text-neutral-200">
          <span>
            Overnight: <span className="font-medium">{day.overnight.name}</span>
            {/* The pin and the Navigate link below point at this campsite,
                not at the town — so say which one, or the link looks like
                it is sending you to the wrong place. */}
            {day.overnight.campsiteSuggestion && (
              <span data-testid="overnight-campsite">
                {' — '}
                {day.overnight.campsiteSuggestion}
              </span>
            )}
          </span>
          <a
            data-testid="overnight-navigate"
            href={navigateUrl(day.overnight)}
            target="_blank"
            rel="noreferrer"
            className="link text-xs font-medium"
          >
            Navigate
          </a>
          {/* Recorded per night by applyOvernightOptions, and only ever on a
              free one: the sentence from this country's own researched rules
              that made sleeping here permissible. Shown next to the pin
              because that is where the question gets asked — standing at a
              lay-by at dusk, working out whether the sign means you. The
              coordinates are a mapped lay-by or free motorhome parking area,
              not a field someone imagined; in a right-to-roam country this
              rule is what says how far off it you may legally go. */}
          {day.overnight.freeCampingRule && (
            <span
              data-testid="overnight-free-camping-rule"
              className="basis-full text-xs text-neutral-500 dark:text-neutral-400"
            >
              Free camping here: {day.overnight.freeCampingRule}
            </span>
          )}
        </p>

        {day.type === 'rest' ? (
          <p
            className="mx-4 mt-2 rounded-xl bg-orange-50 p-3 font-medium text-orange-800 dark:bg-orange-950 dark:text-orange-200"
            data-testid="rest-day-banner"
          >
            No driving today 🎉
          </p>
        ) : (
          day.drive && (
            <div
              className="card mx-4 mt-4 p-3 text-sm"
              data-testid="drive-card"
            >
              <p className="font-semibold text-neutral-900 dark:text-white">
                {day.drive.fromName} → {day.drive.toName}
              </p>
              <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                <span className="chip chip-neutral">
                  {day.drive.distanceKm.toFixed(0)} km
                </span>
                <span className="chip chip-neutral">
                  {day.drive.durationMin.toFixed(0)} min
                </span>
                <span className="chip chip-neutral">{day.drive.slot}</span>
              </div>
              {/* A straight-line guess, not a measured route — see
                  driveLegSchema.estimated. Said out loud because these
                  numbers are indistinguishable from real ones on the card,
                  and pacing was validated against them. */}
              {day.drive.estimated && (
                <p
                  data-testid="drive-card-estimated"
                  className="mt-1.5 text-xs text-neutral-500 dark:text-neutral-400"
                >
                  Distance and time are a straight-line estimate — the routing
                  service could not be reached for this leg.
                </p>
              )}
            </div>
          )
        )}

        <AddCustomStopForm
          tripId={tripId}
          dayId={dayId}
          defaultLocation={{
            name: day.overnight.name,
            lat: day.overnight.lat,
            lng: day.overnight.lng,
          }}
        />

        {detailGate}

        <PlaceCardSection
          title="Activities"
          rowTestId="activities-row"
          cardIdPrefix="activity"
          kind="activity"
          entries={activities.map((place, index) => ({ index, place }))}
          tripId={tripId}
          dayId={dayId}
          date={day.date}
          selectedPlaceId={selectedPlace?.id}
          onSelect={(cardId, place) => setSelectedPlace({ id: cardId, ...place })}
        />

        <PlaceCardSection
          title="Breakfast"
          rowTestId="breakfast-row"
          cardIdPrefix="breakfast"
          kind="restaurant"
          meal="breakfast"
          entries={breakfast.map((place, index) => ({ index, place }))}
          tripId={tripId}
          dayId={dayId}
          date={day.date}
          selectedPlaceId={selectedPlace?.id}
          onSelect={(cardId, place) => setSelectedPlace({ id: cardId, ...place })}
        />

        <PlaceCardSection
          title="Lunch"
          rowTestId="lunch-row"
          cardIdPrefix="lunch"
          kind="restaurant"
          meal="lunch"
          entries={lunch.map((place, index) => ({ index, place }))}
          tripId={tripId}
          dayId={dayId}
          date={day.date}
          selectedPlaceId={selectedPlace?.id}
          onSelect={(cardId, place) => setSelectedPlace({ id: cardId, ...place })}
        />

        <PlaceCardSection
          title="Dinner"
          rowTestId="dinner-row"
          cardIdPrefix="dinner"
          kind="restaurant"
          meal="dinner"
          entries={dinner.map((place, index) => ({ index, place }))}
          tripId={tripId}
          dayId={dayId}
          date={day.date}
          selectedPlaceId={selectedPlace?.id}
          onSelect={(cardId, place) => setSelectedPlace({ id: cardId, ...place })}
        />
      </div>
    </div>
  )
}

export default DayViewScreen
