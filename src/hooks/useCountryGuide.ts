import { useEffect, useState } from 'react'
import { doc, onSnapshot } from 'firebase/firestore'
import type { CountryGuide } from '@rv/shared'
import { db } from '../lib/firebase'

export function useCountryGuide(tripId: string, countryCode: string) {
  const [guide, setGuide] = useState<CountryGuide | undefined>(undefined)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const unsubscribe = onSnapshot(
      doc(db, 'trips', tripId, 'countries', countryCode),
      (snap) => {
        setGuide(snap.exists() ? (snap.data() as CountryGuide) : undefined)
        setLoading(false)
      },
      (error) =>
        console.error('[useCountryGuide] onSnapshot error', countryCode, error),
    )
    return unsubscribe
  }, [tripId, countryCode])

  return { guide, loading }
}
