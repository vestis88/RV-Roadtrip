import { useEffect, useState } from 'react'
import { doc, onSnapshot } from 'firebase/firestore'
import {
  DEFAULT_COUNTRY_BRIEF_SECTIONS,
  countryBriefSchema,
  type CountryBriefSection,
} from '@rv/shared'
import { db } from '../lib/firebase'

/**
 * The traveler's research brief — what gets looked up for every country.
 * Stored on the account, not the trip (asked for 2026-08-02: "I also want
 * the country information saved across trips"), so a new trip starts from
 * the list you already curated instead of the built-in six again.
 *
 * Falls back to the defaults whenever there's nothing stored — including
 * while signing in — because the country screen should show what it *will*
 * research rather than an empty page that looks unconfigured.
 */
export function useCountryBrief(uid: string | null) {
  // `null` means "haven't heard from Firestore yet", which is what
  // distinguishes still-loading from a traveler who has genuinely never
  // edited their brief; both render the defaults, but only one is loading.
  const [stored, setStored] = useState<CountryBriefSection[] | null>(null)
  const [loadedFor, setLoadedFor] = useState<string | null>(uid)
  if (loadedFor !== uid) {
    setLoadedFor(uid)
    setStored(null)
  }

  useEffect(() => {
    if (!uid) return
    const unsubscribe = onSnapshot(
      doc(db, 'users', uid, 'preferences', 'countryBrief'),
      (snap) => {
        const parsed = snap.exists()
          ? countryBriefSchema.safeParse(snap.data())
          : undefined
        setStored(parsed?.success ? parsed.data.sections : [])
      },
      (error) => {
        console.error('[useCountryBrief] onSnapshot error', error)
        setStored([])
      },
    )
    return unsubscribe
  }, [uid])

  return {
    sections: stored && stored.length > 0 ? stored : DEFAULT_COUNTRY_BRIEF_SECTIONS,
    loading: uid != null && stored === null,
  }
}
