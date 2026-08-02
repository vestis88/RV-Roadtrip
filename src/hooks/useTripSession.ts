import { useEffect, useState } from 'react'
import {
  collection,
  doc,
  getDoc,
  getDocs,
  limit,
  orderBy,
  query,
  setDoc,
  updateDoc,
} from 'firebase/firestore'
import { httpsCallable } from 'firebase/functions'
import type { TripSettings } from '@rv/shared'
import { db, ensureSignedIn, functions } from '../lib/firebase'

export function useTripSession() {
  const [tripId, setTripId] = useState<string | null>(null)
  const [uid, setUid] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false

    async function run() {
      const user = await ensureSignedIn()
      if (cancelled) return
      setUid(user.uid)

      const params = new URLSearchParams(window.location.search)
      const joinCode = params.get('join')
      const storedTripId = localStorage.getItem('tripId')

      if (joinCode) {
        const join = httpsCallable<{ shareCode: string }, { tripId: string }>(
          functions,
          'joinTrip',
        )
        const { data } = await join({ shareCode: joinCode })
        if (cancelled) return
        localStorage.setItem('tripId', data.tripId)
        setTripId(data.tripId)
        // Strip ?join= once handled — left in place, a later reload (now
        // that switching trips is possible) would silently re-join and
        // hijack whichever trip the traveler has since switched to.
        const url = new URL(window.location.href)
        url.searchParams.delete('join')
        window.history.replaceState({}, '', url)
        return
      }

      if (storedTripId) {
        setTripId(storedTripId)
        // Self-heal: a trip created before the users/{uid}/trips reverse
        // index existed (or any other write path that landed membership
        // without it) is otherwise permanently invisible in "My trips" —
        // reported as an old trip vanishing from the switcher while still
        // being the active trip. Only ever fills in a MISSING doc, never
        // overwrites an existing one's real joinedAt.
        try {
          const reverseIndexRef = doc(db, 'users', user.uid, 'trips', storedTripId)
          const reverseIndexSnap = await getDoc(reverseIndexRef)
          if (!reverseIndexSnap.exists()) {
            await setDoc(reverseIndexRef, { joinedAt: new Date().toISOString() })
          }
        } catch (error) {
          console.error('Failed to backfill trip reverse index', error)
        }
        return
      }

      // Nothing stored locally does NOT mean "new traveler" any more.
      // Signing in on a second device is now the normal way to reach your
      // own trips (they hang off the account, not the browser), so create
      // only when the account genuinely has none — otherwise a new phone
      // would greet you with an empty trip while your real ones sat one
      // menu away.
      const existing = await getDocs(
        query(
          collection(db, 'users', user.uid, 'trips'),
          orderBy('joinedAt', 'desc'),
          limit(1),
        ),
      )
      if (cancelled) return
      if (!existing.empty) {
        const mostRecent = existing.docs[0].id
        localStorage.setItem('tripId', mostRecent)
        setTripId(mostRecent)
        return
      }

      const create = httpsCallable<void, { tripId: string; shareCode: string }>(
        functions,
        'createTrip',
      )
      const { data } = await create()
      if (cancelled) return
      localStorage.setItem('tripId', data.tripId)
      setTripId(data.tripId)
    }

    run().catch((error: unknown) => console.error('Trip session failed', error))
    return () => {
      cancelled = true
    }
  }, [])

  /** Switches the active trip to one the traveler is already a member of
   * (own trip list, or one just joined) — no backend call needed, membership
   * already exists. */
  function switchTrip(id: string) {
    localStorage.setItem('tripId', id)
    setTripId(id)
  }

  /**
   * Creates a brand-new trip and switches to it immediately. `inherit`
   * (typically the previous trip's own settings/notes) carries every
   * travel-setup field over except `startPoint`/`endPoint`, which stay the
   * fresh trip's own defaults — a new trip almost always means a new route,
   * but the vehicle, travelers, interests, pacing preferences, and any
   * free-text notes are usually the same household planning it. A plain
   * client-side patch after creation rather than a new callable parameter —
   * `createTrip` stays the same one-step "make me a blank trip" primitive
   * `joinTrip`'s reverse-index write and every existing test already
   * exercise; only the caller changes.
   */
  async function startNewTrip(inherit?: {
    settings: TripSettings
    notesFreeText: string
  }): Promise<string> {
    const create = httpsCallable<void, { tripId: string; shareCode: string }>(
      functions,
      'createTrip',
    )
    const { data } = await create()
    if (inherit) {
      const carriedOverKeys = Object.keys(inherit.settings).filter(
        (key) => key !== 'startPoint' && key !== 'endPoint',
      ) as Array<keyof TripSettings>
      const updates: Record<string, unknown> = Object.fromEntries(
        carriedOverKeys.map((key) => [`settings.${key}`, inherit.settings[key]]),
      )
      if (inherit.notesFreeText) {
        updates['notes.freeText'] = inherit.notesFreeText
        updates['notes.updatedAt'] = new Date().toISOString()
      }
      await updateDoc(doc(db, 'trips', data.tripId), updates)
    }
    localStorage.setItem('tripId', data.tripId)
    setTripId(data.tripId)
    return data.tripId
  }

  return { tripId, uid, switchTrip, startNewTrip }
}
