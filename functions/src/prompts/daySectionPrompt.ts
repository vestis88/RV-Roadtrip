import type { Meal, TripSettings } from '@rv/shared'
import type { RouteOutlineDay } from './planTripSchema.js'

/**
 * One day, one section.
 *
 * Requested 2026-08-25: "the content could be generated for it with a click
 * on that empty header (lunch) for instance."
 *
 * A SEPARATE prompt rather than a narrowed DETAIL_SYSTEM_PROMPT, deliberately.
 * That one is tuned, sits in the paid whole-trip path, and its response shape
 * is "exactly 5 activities and exactly 9 restaurants" — editing it to take a
 * category would put every full generation at risk to serve a button. This
 * asks a smaller question and answers it in a smaller shape.
 *
 * What it must NOT drift from is the blurb rule, which is the whole reason
 * this goes to Claude at all: `researchMoreAlternatives` already fills
 * sections from Places' top-rated-nearby with a template sentence, and that
 * is exactly what produced "the descriptions for activities seem to have
 * become quite generic" on 2026-08-18. A test asserts both prompts still
 * carry it.
 */
export const ANTI_GENERIC_BLURB_RULE =
  'The "blurb" is what the traveler actually reads when deciding whether to ' +
  'spend an afternoon on this, so write 2-3 real sentences. First say what is ' +
  'genuinely THERE — what you see or do, roughly how long it takes, what the ' +
  'setting is like — and then connect that to THESE travelers: their stated ' +
  'interests, the ages of any children, and anything in their notes. Do not ' +
  'write a single generic sentence: "A well-rated local hike." is what this ' +
  'app writes ITSELF when it could not find the place you named, so a blurb ' +
  'of that shape is indistinguishable from a failure.'

const SLOT_RULE =
  'The day\'s "drive.slot" tells you when the driving happens, which decides ' +
  'how much non-driving time is actually available. "morning" means the drive ' +
  'comes first, so this happens after arrival, near THIS day\'s overnight ' +
  'town. "evening" means the drive comes last, so it happens before departure, ' +
  'near the PREVIOUS town. "midday" splits the day. A "rest" day is free all ' +
  'day. Never propose something that assumes more time than the slot leaves.'

const NO_INVENTED_FACTS_RULE =
  'Provide ONLY a name, town, category (or meal) and a blurb. Do NOT invent ' +
  'ratings, review counts, opening hours or URLs — those are resolved from ' +
  'Google Places after you respond.'

export const SECTION_ACTIVITY_COUNT = 5
export const SECTION_RESTAURANT_COUNT = 3

export function buildDaySectionPrompt(input: {
  settings: TripSettings
  notesFreeText: string
  day: RouteOutlineDay
  kind: 'activity' | 'restaurant'
  meal?: Meal
  /** Already on this day, so the same place is not proposed twice. */
  existingNames: string[]
}): { system: string; user: string } {
  const what =
    input.kind === 'activity'
      ? `exactly ${SECTION_ACTIVITY_COUNT} activities (a mix of famous sights and hidden gems, flagging which are kid-friendly given the ages of any child travelers), matched to the stated interests`
      : `exactly ${SECTION_RESTAURANT_COUNT} places for ${input.meal}`

  const shape =
    input.kind === 'activity'
      ? '{ "activities": [ { "name": string, "town": string, "category": "sight"|"hike"|"museum"|"beach"|"playground"|"bike"|"ski"|"other", "kidFriendly": boolean, "blurb": string } ] }'
      : `{ "restaurants": [ { "name": string, "town": string, "meal": "${input.meal}", "cuisine"?: string, "blurb": string } ] }`

  const system = [
    'You are an expert European tour guide specializing in RV travel and hidden gems for families.',
    `You are filling in ONE PART of ONE day of a trip whose route is already decided. Do not change the route. Propose ${what}.`,
    // The stop the day exists for. Without this the suggestions drift away
    // from the reason the traveler is in that town at all — the same failure
    // the whole-trip prompt guards with its "sights" rule.
    'The day carries a "sights" list: the places the route was built around for that day, and the only reason the trip passes through this town. Everything you propose must be a sensible companion to those, not a replacement for them.',
    SLOT_RULE,
    NO_INVENTED_FACTS_RULE,
    ANTI_GENERIC_BLURB_RULE,
    'Anything in "alreadyOnThisDay" is already suggested here — do not repeat it, and do not mention that you avoided it.',
    `Respond with JSON ONLY — no prose, no markdown fences — matching exactly: ${shape}`,
  ].join('\n\n')

  const user = JSON.stringify({
    settings: input.settings,
    notes: input.notesFreeText,
    day: input.day,
    alreadyOnThisDay: input.existingNames,
  })

  return { system, user }
}
