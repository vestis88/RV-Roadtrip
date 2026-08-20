import { useEffect, useState } from 'react'
import { addDoc, collection, serverTimestamp } from 'firebase/firestore'
import type { Trip } from '@rv/shared'
import { db } from '../lib/firebase'
import type { TripDayWithId } from './useTripDays'
import { isTripActiveToday } from '../lib/executionMode'
import { planDrift, shouldPromptReplan, type PlanDrift } from '../lib/planDrift'

const CHECK_INTERVAL_MS = 30 * 60 * 1000

interface LatLng {
  lat: number
  lng: number
}

export function useExecutionMode(
  tripId: string,
  trip: Trip,
  days: TripDayWithId[],
) {
  const today = new Date().toISOString().slice(0, 10)
  const snoozeKey = `execution-snooze-${tripId}-${today}`

  const [drift, setDrift] = useState<PlanDrift | null>(null)
  const [permissionDenied, setPermissionDenied] = useState(false)
  const [snoozed, setSnoozed] = useState(
    () => localStorage.getItem(snoozeKey) === 'true',
  )
  const [lastPosition, setLastPosition] = useState<LatLng | null>(null)

  const active = isTripActiveToday(
    today,
    trip.settings.startDate,
    trip.settings.endDate,
  )
  // The WHOLE plan, not just tonight — drift is now measured as progress
  // along the route rather than as distance to one town, so every night is
  // part of the measurement. Serialised into the effect's dependencies so a
  // fresh `days` array with identical contents cannot restart the timer (and
  // so re-ask for a GPS fix) on every snapshot.
  const nights = days.map((day) => ({ date: day.date, overnight: day.overnight }))
  const nightsKey = nights
    .map((night) => `${night.date}:${night.overnight.lat}:${night.overnight.lng}`)
    .join('|')
  const start = trip.settings.startPoint
  const startLat = start.lat
  const startLng = start.lng

  useEffect(() => {
    if (!active || snoozed || nightsKey === '') return
    const plannedNights = nightsKey.split('|').map((entry) => {
      const [date, lat, lng] = entry.split(':')
      return { date, overnight: { lat: Number(lat), lng: Number(lng) } }
    })

    function checkPosition() {
      navigator.geolocation.getCurrentPosition(
        (position) => {
          const here = {
            lat: position.coords.latitude,
            lng: position.coords.longitude,
          }
          setLastPosition(here)
          setPermissionDenied(false)
          setDrift(
            planDrift({
              start: { lat: startLat, lng: startLng },
              nights: plannedNights,
              today,
              here,
            }),
          )
        },
        () => setPermissionDenied(true),
        { timeout: 8000 },
      )
    }

    checkPosition()
    const interval = setInterval(checkPosition, CHECK_INTERVAL_MS)
    return () => clearInterval(interval)
  }, [active, snoozed, nightsKey, today, startLat, startLng])

  // One place decides whether the gap is worth saying out loud, so the
  // banner, the replan payload and the returned value can never disagree
  // about it.
  const prompting = shouldPromptReplan(drift)

  function snoozeToday() {
    localStorage.setItem(snoozeKey, 'true')
    setSnoozed(true)
    setDrift(null)
  }

  function submitManualPosition(position: LatLng) {
    setLastPosition(position)
    setPermissionDenied(false)
    setDrift(planDrift({ start, nights, today, here: position }))
  }

  async function replan() {
    const currentLocation = lastPosition ?? trip.settings.startPoint
    await addDoc(collection(db, 'planRequests'), {
      tripId,
      kind: 'replan',
      status: 'pending',
      createdAt: serverTimestamp(),
      replanContext: {
        currentLocation,
        today,
        completedRefPaths: [],
        remainingEndDate: trip.settings.endDate,
        remainingEndPoint: trip.settings.endPoint,
        // Distinguishes this from a voluntary "Request changes" edit so the
        // replan asks for an easy first day instead of pacing it the same
        // as the rest of the remainder (bug fix, reported 2026-07-27 — see
        // replanTrip.ts's notesFreeText construction).
        // Only a real shortfall is sent. A traveler who is AHEAD has a
        // negative gap, and telling the replan they are minus-eighty
        // kilometres behind would ask it to solve a problem that is not
        // happening — the old distance-only measure had no sign and could
        // not have made this distinction.
        ...(prompting && drift ? { behindScheduleKm: drift.behindKm } : {}),
      },
    })
    setDrift(null)
  }

  return {
    active,
    drift: prompting ? drift : null,
    permissionDenied,
    snoozeToday,
    submitManualPosition,
    replan,
  }
}
