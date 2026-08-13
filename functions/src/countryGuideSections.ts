import { getFirestore } from 'firebase-admin/firestore'
import { FREE_CAMPING_SECTION_ID } from '@rv/shared'
import type { CountryGuideSection } from '@rv/shared'

/**
 * Where researched country guide sections live.
 *
 * Deliberately here and not in countrySectionsCallable.ts, which is where it
 * started. That file imports prompts/countrySection.js for the research call,
 * which is where CLAUDE_API_KEY is defined — so importing the collection name
 * from it drags the secret into the importer's graph, and
 * secretsDeclaration.test.ts (rightly) fails any entry point that can reach a
 * secret it doesn't declare. The overnight pass needs the name and has no
 * business anywhere near Claude, so the name lives in a module that imports
 * nothing but Firestore.
 */
export const COUNTRY_GUIDE_SECTIONS_COLLECTION = 'countryGuideSections'

/**
 * Whether a night may be spent in a free spot in one country, and the
 * researched sentence that says so.
 */
export interface FreeCampingPolicy {
  permitted: boolean
  /**
   * The finding the verdict was read off — recorded on the day so the
   * traveler can check the reasoning at the roadside rather than take the
   * planner's word for it. Null when nothing in the guide spoke to it.
   */
  rule: string | null
}

/**
 * A statement of a general right to camp on open land. These are the terms
 * that name a national right rather than describe one, which is why they are
 * treated as decisive: a country either has one or it doesn't.
 */
const RIGHT_TO_ROAM =
  /allemansr|allemannsr|jokamiehen|everyman'?s right|right to roam|freedom to roam/i

/**
 * A general prohibition. Matched before permission on purpose — "not
 * allowed" and "does not permit" contain the permissive words, so a
 * permission test alone reads them backwards.
 */
const PROHIBITION =
  /\b(?:prohibit\w*|forbidden|banned|illegal|not\s+(?:legal|permitted|allowed)|(?:does|do)\s+not\s+(?:allow|permit)|no\s+(?:legal\s+)?right)\b/i

/** An explicit statement that it is allowed, for countries with no named right. */
const PERMISSION = /\b(?:is|are)\s+(?:\w+\s+){0,3}?(?:legal|permitted|allowed)\b/i

/** Findings are prose; the verdict is per sentence, so a caveat in the second
 * sentence cannot overturn the right asserted in the first. */
function sentences(item: string): string[] {
  return item.split(/(?<=[.;!?])\s+/)
}

/**
 * Reads a verdict on free camping out of one country's researched
 * free-camping findings.
 *
 * This is classification of prose, so it is built to fail in the safe
 * direction. Committing a night somewhere it is not allowed costs a fine or
 * a knock on the door at 2am; refusing one that would have been fine costs a
 * campsite fee. So:
 *
 *  - nothing researched for the country at all is NOT permission. An
 *    unresearched country is exactly the case where nobody has checked.
 *  - a named right to roam (allemansrätten and its cousins) is decisive,
 *    unless the same sentence is denying that the country has one — "unlike
 *    Sweden's allemansrätten, Denmark does not allow wild camping" is a
 *    sentence about Sweden's right, in Denmark's guide.
 *  - a general prohibition anywhere in the findings beats a bare "it is
 *    allowed" elsewhere in them, because that is how the strict countries
 *    read: permitted in a named exception, prohibited otherwise.
 *
 * What it deliberately does NOT do is decide the caveats. Sweden's 150m from
 * a dwelling, Norway's national parks, the one-night limit — those stay
 * prose, recorded on the day and read by the traveler, because a boolean was
 * never going to carry them.
 */
export function freeCampingPolicy(
  items: string[] | undefined,
): FreeCampingPolicy {
  if (!items || items.length === 0) return { permitted: false, rule: null }

  let prohibition: string | null = null
  let permission: string | null = null

  for (const item of items) {
    for (const sentence of sentences(item)) {
      const prohibits = PROHIBITION.test(sentence)
      if (RIGHT_TO_ROAM.test(sentence) && !prohibits) {
        return { permitted: true, rule: item }
      }
      if (prohibits) prohibition ??= item
      else if (PERMISSION.test(sentence)) permission ??= item
    }
  }

  if (prohibition) return { permitted: false, rule: prohibition }
  if (permission) return { permitted: true, rule: permission }
  return { permitted: false, rule: null }
}

/**
 * Each country's researched free-camping findings, for the countries a trip
 * actually crosses.
 *
 * Country research lives outside any trip (2026-08-02) so it is reused
 * across trips: free-camping rules are cached per country, not per vehicle,
 * so whichever entry exists for a country serves every trip that passes
 * through it — including one whose vehicle is nothing like the one that
 * triggered the research.
 *
 * Best-effort per country, and best-effort as a whole. A country nobody has
 * researched yet is normal rather than an error, and a Firestore hiccup on
 * one country must not cost the other fourteen their answer — a missing
 * entry only means that country's nights are planned as though free camping
 * were not permitted, which is what an unresearched country deserves.
 */
export async function loadFreeCampingRulesByCountry(
  countryCodes: string[],
): Promise<Map<string, string[]>> {
  const db = getFirestore()
  const unique = [...new Set(countryCodes)]
  const found = new Map<string, string[]>()

  await Promise.all(
    unique.map(async (countryCode) => {
      try {
        // One document per (country, brief, vehicle scope): several can exist
        // for a country once someone edits their research brief. Any of them
        // is an answer to "what are this country's rules", so take the first
        // rather than trying to work out whose brief was better.
        const snap = await db
          .collection(COUNTRY_GUIDE_SECTIONS_COLLECTION)
          .where('countryCode', '==', countryCode)
          .where('sectionId', '==', FREE_CAMPING_SECTION_ID)
          .limit(1)
          .get()
        if (snap.empty) return
        found.set(countryCode, (snap.docs[0].data() as CountryGuideSection).items)
      } catch (error) {
        console.warn(
          `Free-camping rules lookup failed for ${countryCode}; planning it as not permitted`,
          error,
        )
      }
    }),
  )

  return found
}
