import { useEffect, useMemo, useState } from 'react'
import { collection, onSnapshot, query, where } from 'firebase/firestore'
import {
  countryGuideSectionDocId,
  type CountryBriefSection,
  type CountryGuideSection,
  type Vehicle,
} from '@rv/shared'
import { db } from '../lib/firebase'

export interface ResolvedSection {
  section: CountryBriefSection
  /** Undefined when this section has never been researched for this country. */
  guide?: CountryGuideSection
}

/**
 * Pairs each section of the traveler's brief with its stored research, if
 * any exists for this country.
 *
 * The lookup is by document ID rather than by a "latest guide" query,
 * because the ID is what encodes correctness: it carries the country, the
 * section's brief and — for vehicle-dependent sections — the vehicle (see
 * countryGuideSectionDocId). A section whose brief was edited, or whose
 * answer depends on an RV you no longer drive, therefore simply doesn't
 * match, and shows as un-researched instead of silently serving an answer
 * to a different question.
 *
 * One live query per country, filtered client-side to the IDs that matter:
 * a country has a handful of sections, and this way adding a section to the
 * brief doesn't need a new listener.
 */
export function useCountryGuideSections(
  countryCode: string,
  sections: CountryBriefSection[],
  vehicle: Vehicle | undefined,
) {
  // `null` until Firestore has answered — a country nobody has researched
  // yet and a country still loading both render no findings, but only one
  // of them should say "loading".
  const [byDocId, setByDocId] = useState<Record<
    string,
    CountryGuideSection
  > | null>(null)
  const [loadedFor, setLoadedFor] = useState(countryCode)
  if (loadedFor !== countryCode) {
    setLoadedFor(countryCode)
    setByDocId(null)
  }

  useEffect(() => {
    if (!countryCode) return
    const unsubscribe = onSnapshot(
      query(
        collection(db, 'countryGuideSections'),
        where('countryCode', '==', countryCode),
      ),
      (snap) => {
        const next: Record<string, CountryGuideSection> = {}
        for (const docSnap of snap.docs) {
          next[docSnap.id] = docSnap.data() as CountryGuideSection
        }
        setByDocId(next)
      },
      (error) => {
        console.error('[useCountryGuideSections] onSnapshot error', countryCode, error)
        setByDocId({})
      },
    )
    return unsubscribe
  }, [countryCode])

  const resolved = useMemo<ResolvedSection[]>(() => {
    if (!vehicle || !byDocId) return sections.map((section) => ({ section }))
    return sections.map((section) => ({
      section,
      guide: byDocId[countryGuideSectionDocId({ countryCode, section, vehicle })],
    }))
  }, [sections, byDocId, countryCode, vehicle])

  return { resolved, loading: byDocId === null }
}
