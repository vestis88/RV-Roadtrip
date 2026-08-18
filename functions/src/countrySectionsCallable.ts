import { getFirestore } from 'firebase-admin/firestore'
import { HttpsError, onCall } from 'firebase-functions/https'
import { describeCause } from './describeCause.js'
import {
  DEFAULT_COUNTRY_BRIEF_SECTIONS,
  countryGuideSectionDocId,
  countryBriefSchema,
  type CountryBriefSection,
  type CountryGuideSection,
  type TripSettings,
} from '@rv/shared'
import { requireAccess } from './accessControl.js'
import { requireTripMember } from './authz.js'
import { COUNTRY_GUIDE_SECTIONS_COLLECTION } from './countryGuideSections.js'
import { claudeApiKey, generateCountrySection } from './prompts/countrySection.js'

const COUNTRY_BRIEF_PATH = ['preferences', 'countryBrief'] as const

/**
 * The traveler's own research brief, from their account rather than from the
 * request: the brief is what gets fed to Claude, so reading it server-side
 * keeps the callable's prompt inputs to things the caller already owns —
 * the client only says *which* sections to research, never what to ask.
 * Falls back to the built-in six for anyone who has never edited it.
 */
export async function loadCountryBrief(uid: string): Promise<CountryBriefSection[]> {
  const snap = await getFirestore()
    .collection('users')
    .doc(uid)
    .collection(COUNTRY_BRIEF_PATH[0])
    .doc(COUNTRY_BRIEF_PATH[1])
    .get()
  if (!snap.exists) return DEFAULT_COUNTRY_BRIEF_SECTIONS
  const parsed = countryBriefSchema.safeParse(snap.data())
  if (!parsed.success || parsed.data.sections.length === 0) {
    // A malformed brief shouldn't wedge research entirely — the defaults are
    // always a usable answer to "what should I look up".
    console.warn('Malformed country brief; falling back to defaults', uid)
    return DEFAULT_COUNTRY_BRIEF_SECTIONS
  }
  return parsed.data.sections
}

/**
 * Researches the named sections for one country and stores each one on its
 * own, outside any trip.
 *
 * Sections are independent by construction: one Claude call each, one
 * document each, keyed so that a document is only ever reused when the
 * country, the section's brief and (where it matters) the vehicle all
 * match. That's what "add one item without re-running the rest" comes down
 * to — the five you already had aren't inputs to the sixth, so nothing
 * touches them.
 *
 * Runs the requested sections concurrently. Each is separately fallible:
 * one section failing (a bad web search, a malformed response) leaves the
 * others written rather than losing the whole batch, and the caller is told
 * which ones didn't land.
 */
export async function researchCountrySectionsForTrip(input: {
  tripId: string
  uid: string
  countryCode: string
  countryName: string
  sectionIds: string[]
}): Promise<{
  researched: string[]
  failed: string[]
  failureReasons: Record<string, string>
}> {
  const db = getFirestore()
  const tripSnap = await db.collection('trips').doc(input.tripId).get()
  const settings = tripSnap.data()?.settings as TripSettings | undefined
  if (!settings) {
    throw new HttpsError('not-found', 'Trip not found')
  }

  const brief = await loadCountryBrief(input.uid)
  const requested = brief.filter((section) => input.sectionIds.includes(section.id))
  if (requested.length === 0) {
    throw new HttpsError(
      'invalid-argument',
      'None of those sections are in your research list',
    )
  }

  const researched: string[] = []
  const failed: string[] = []
  // Why each one failed, keyed by section id. Added 2026-08-18: the cause was
  // logged here and then thrown away, so "Could not research 4 of 4" was the
  // most the traveler could ever be told, and the section list said only
  // "Not researched for this country yet" — which describes a country nobody
  // has asked about, not one that was asked about and could not answer.
  const failureReasons: Record<string, string> = {}

  await Promise.all(
    requested.map(async (section) => {
      try {
        const { items, sources } = await generateCountrySection({
          countryCode: input.countryCode,
          countryName: input.countryName,
          section,
          vehicle: settings.vehicle,
          tripId: input.tripId,
        })
        const doc: CountryGuideSection = {
          countryCode: input.countryCode,
          sectionId: section.id,
          title: section.title,
          items,
          sources,
          generatedAt: new Date().toISOString(),
        }
        await db
          .collection(COUNTRY_GUIDE_SECTIONS_COLLECTION)
          .doc(
            countryGuideSectionDocId({
              countryCode: input.countryCode,
              section,
              vehicle: settings.vehicle,
            }),
          )
          .set(doc)
        researched.push(section.id)
      } catch (error) {
        console.error('Country section research failed', section.id, error)
        failed.push(section.id)
        failureReasons[section.id] = describeCause(error)
      }
    }),
  )

  return { researched, failed, failureReasons }
}

export const researchCountrySections = onCall(
  {
    secrets: [claudeApiKey],
    // Same reasoning as the whole-guide callable this replaces: web search
    // plus a retry can exceed the 60s default. Sections run concurrently, so
    // researching six is not six times one.
    timeoutSeconds: 180,
  },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError('unauthenticated', 'Must be signed in')
    }
    requireAccess(request.auth)
    const tripId = request.data?.tripId
    const countryCode = request.data?.countryCode
    const countryName = request.data?.countryName
    const sectionIds = request.data?.sectionIds
    if (
      typeof tripId !== 'string' ||
      typeof countryCode !== 'string' ||
      countryCode.length !== 2 ||
      typeof countryName !== 'string' ||
      !Array.isArray(sectionIds) ||
      sectionIds.length === 0 ||
      sectionIds.some((id) => typeof id !== 'string')
    ) {
      throw new HttpsError(
        'invalid-argument',
        'tripId, countryCode, countryName and a non-empty sectionIds array are required',
      )
    }
    // One Claude call per section, so an unbounded list is an unbounded
    // bill — the brief itself is the real limit, this just refuses a
    // hand-crafted request that ignores it.
    if (sectionIds.length > 20) {
      throw new HttpsError('invalid-argument', 'Too many sections in one request')
    }
    await requireTripMember(tripId, request.auth.uid)
    return researchCountrySectionsForTrip({
      tripId,
      uid: request.auth.uid,
      countryCode,
      countryName,
      sectionIds: sectionIds as string[],
    })
  },
)
