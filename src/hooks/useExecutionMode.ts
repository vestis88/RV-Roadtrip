import { useEffect, useState } from 'react'
import { addDoc, collection, serverTimestamp } from 'firebase/firestore'
import type { Trip } from '@rv/shared'
import { db } from '../lib/firebase'
import type { TripDayWithId } from './useTripDays'
import {
  haversineDistanceKm,
  isTripActiveToday,
  shouldPromptReplan,
} from '../lib/executionMode'

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

  const [behindKm, setBehindKm] = useState<number | null>(null)
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
  const todayDay = days.find((d) => d.date === today)
  const todayOvernightLat = todayDay?.overnight.lat
  const todayOvernightLng = todayDay?.overnight.lng

  useEffect(() => {
    if (!active || snoozed || todayOvernightLat == null || todayOvernightLng == null) {
      return
    }
    const overnight = { lat: todayOvernightLat, lng: todayOvernightLng }

    function checkPosition() {
      navigator.geolocation.getCurrentPosition(
        (position) => {
          const here = {
            lat: position.coords.latitude,
            lng: position.coords.longitude,
          }
          setLastPosition(here)
          setPermissionDenied(false)
          const distance = haversineDistanceKm(here, overnight)
          setBehindKm(shouldPromptReplan(distance) ? distance : null)
        },
        () => setPermissionDenied(true),
        { timeout: 8000 },
      )
    }

    checkPosition()
    const interval = setInterval(checkPosition, CHECK_INTERVAL_MS)
    return () => clearInterval(interval)
  }, [active, snoozed, todayOvernightLat, todayOvernightLng])

  function snoozeToday() {
    localStorage.setItem(snoozeKey, 'true')
    setSnoozed(true)
    setBehindKm(null)
  }

  function submitManualPosition(position: LatLng) {
    setLastPosition(position)
    setPermissionDenied(false)
    if (todayOvernightLat == null || todayOvernightLng == null) return
    const distance = haversineDistanceKm(position, {
      lat: todayOvernightLat,
      lng: todayOvernightLng,
    })
    setBehindKm(shouldPromptReplan(distance) ? distance : null)
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
        ...(behindKm != null ? { behindScheduleKm: behindKm } : {}),
      },
    })
    setBehindKm(null)
  }

  return {
    active,
    behindKm,
    permissionDenied,
    snoozeToday,
    submitManualPosition,
    replan,
  }
}
