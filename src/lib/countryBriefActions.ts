import { doc, setDoc } from 'firebase/firestore'
import { httpsCallable } from 'firebase/functions'
import type { CountryBriefSection } from '@rv/shared'
import { db, functions } from './firebase'
import { LONG_CALLABLE_TIMEOUT_MS } from './callableTimeouts'
import { isDeadlineExceeded, serverAuthoredMessage } from './callableError'

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
): Promise<{
  researched: string[]
  failed: string[]
  failureReasons: Record<string, string>
}> {
  const call = httpsCallable<
    {
      tripId: string
      countryCode: string
      countryName: string
      sectionIds: string[]
    },
    {
      researched: string[]
      failed: string[]
      // Absent from an older deployment, hence the fallback below.
      failureReasons?: Record<string, string>
    }
  >(functions, 'researchCountrySections', { timeout: LONG_CALLABLE_TIMEOUT_MS })
  const result = await call({ tripId, countryCode, countryName, sectionIds })
  return {
    researched: result.data.researched,
    failed: result.data.failed,
    failureReasons: result.data.failureReasons ?? {},
  }
}

/**
 * What to tell the traveler when researching a country went wrong.
 *
 * The screen used to say "Could not research that right now — please try
 * again" for every failure, which threw away messages the server had written
 * for exactly this moment and gave the one piece of advice that cannot help a
 * deterministic fault. Reported with a screenshot of that line under
 * Germany's four unresearched sections.
 */
export const GENERIC_RESEARCH_ERROR =
  'Could not research that right now — please try again.'

/**
 * Researching runs one web-search-backed Claude call per section, all at
 * once, against the function's own 180s ceiling — so "four missing" is four
 * of them racing one clock. Re-pressing asks for exactly the same race, and
 * the lever that actually helps is asking for fewer.
 */
const RESEARCH_TIMEOUT_MESSAGE =
  'That research took too long to finish. Try one section at a time — each ' +
  'one runs its own web search, and asking for several at once races them ' +
  'all against the same time limit.'

export function describeResearchError(error: unknown): string {
  if (isDeadlineExceeded(error)) return RESEARCH_TIMEOUT_MESSAGE
  return serverAuthoredMessage(error) ?? GENERIC_RESEARCH_ERROR
}

/**
 * What to say when the call SUCCEEDED but some sections did not.
 *
 * The count on its own ("Could not research 4 of 4") describes the shape of
 * the failure and nothing about its cause, which is the same complaint the
 * explore search had: the server knew, and said nothing. `reasons` is keyed
 * by section id — one distinct cause is worth naming, several are summarised
 * rather than listed, since four copies of the same sentence is not four
 * times the information.
 */
export function describePartialResearchFailure(
  failed: string[],
  requested: number,
  reasons: Record<string, string>,
  titleOf: (sectionId: string) => string,
): string {
  const head =
    failed.length === requested
      ? failed.length === 1
        ? `Could not research ${titleOf(failed[0])}.`
        : `Could not research any of the ${requested} sections.`
      : `Could not research ${failed.length} of ${requested} — the rest are saved.`
  const distinct = [...new Set(failed.map((id) => reasons[id]).filter(Boolean))]
  if (distinct.length === 0) return head
  if (distinct.length === 1) return `${head} ${distinct[0]}`
  return `${head} ${distinct.length} different causes; the first was: ${distinct[0]}`
}
