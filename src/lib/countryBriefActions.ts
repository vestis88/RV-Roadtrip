import { doc, setDoc } from 'firebase/firestore'
import { httpsCallable } from 'firebase/functions'
import type { CountryBriefSection } from '@rv/shared'
import { db, functions } from './firebase'
import { LONG_CALLABLE_TIMEOUT_MS } from './callableTimeouts'

/** Turns a section's title into a stable, readable document key. */
export function sectionIdFromTitle(title: string): string {
  const slug = title
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40)
  return slug || `section-${Date.now()}`
}

/** Only ever writes the whole list — sections are ordered, and the order is
 * the traveler's own. A plain client write, like every other preference. */
export async function saveCountryBrief(
  uid: string,
  sections: CountryBriefSection[],
): Promise<void> {
  await setDoc(doc(db, 'users', uid, 'preferences', 'countryBrief'), {
    sections,
    updatedAt: new Date().toISOString(),
  })
}

/**
 * Researches exactly the named sections. The point of the whole redesign:
 * pass one id and one section is looked up, leaving every other section's
 * stored answer untouched.
 */
export async function researchCountrySections(
  tripId: string,
  countryCode: string,
  countryName: string,
  sectionIds: string[],
): Promise<{ researched: string[]; failed: string[] }> {
  const call = httpsCallable<
    {
      tripId: string
      countryCode: string
      countryName: string
      sectionIds: string[]
    },
    { researched: string[]; failed: string[] }
  >(functions, 'researchCountrySections', { timeout: LONG_CALLABLE_TIMEOUT_MS })
  const result = await call({ tripId, countryCode, countryName, sectionIds })
  return result.data
}
