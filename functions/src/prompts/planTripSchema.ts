import { z } from 'zod'
import { isoDate, sightTimeNeededSchema } from '@rv/shared'

const skeletonPointSchema = z.object({
  name: z.string(),
  town: z.string(),
  country: z.string().length(2),
  campsiteSuggestion: z.string().optional(),
})

const skeletonActivitySchema = z.object({
  name: z.string(),
  town: z.string(),
  category: z.enum([
    'sight',
    'hike',
    'museum',
    'beach',
    'playground',
    'bike',
    'ski',
    'other',
  ]),
  kidFriendly: z.boolean(),
  blurb: z.string(),
})

const skeletonRestaurantSchema = z.object({
  name: z.string(),
  town: z.string(),
  meal: z.enum(['breakfast', 'lunch', 'dinner']),
  cuisine: z.string().optional(),
  blurb: z.string(),
})

const skeletonDriveSchema = z.object({
  fromTown: z.string(),
  toTown: z.string(),
  slot: z.enum(['morning', 'midday', 'evening']),
})

export const planTripSkeletonDaySchema = z.object({
  index: z.number().int().nonnegative(),
  date: isoDate,
  type: z.enum(['drive', 'rest']),
  overnight: skeletonPointSchema,
  drive: skeletonDriveSchema.optional(),
  summary: z.string(),
  extraTimeReason: z.string().optional(),
  highlightReason: z.string().optional(),
  // Carried straight from the outline day (see routeOutlineDaySchema.sights)
  // so it survives the detail phase and reaches the TripDay — pacing needs to
  // know how much of the day the sights themselves eat, and the detail call
  // neither knows nor echoes that back.
  sights: z.array(z.string()).optional(),
  activities: z.array(skeletonActivitySchema).length(5),
  restaurants: z.array(skeletonRestaurantSchema).length(9),
})

export const planTripSkeletonSchema = z.object({
  days: z.array(planTripSkeletonDaySchema).min(1),
})

export type PlanTripSkeletonDay = z.infer<typeof planTripSkeletonDaySchema>
export type PlanTripSkeleton = z.infer<typeof planTripSkeletonSchema>

// Phase 0 of planTrip's three-phase generation: a pure curation pass, before
// any dates or pacing are considered. For each region/country the trip is
// likely to pass through, Claude reasons at a high level about what's
// genuinely worth seeing for these travelers and produces a ranked
// shortlist. The route outline (phase 1) then SELECTS from this shortlist
// under real time/distance constraints, instead of trying to both curate
// and schedule in a single call — which is what previously biased routes
// toward whatever town was closest to the direct line.
//
// Sights lead the route (2026-08-13). The unit of curation used to be a
// TOWN — "which towns along this corridor are worth sleeping in" — with the
// sights inside it left implicit, so a trip could be routed through a town
// whose one reason for existing on the list never made it into any day.
// The unit is a SIGHT now: `sight` is what shouldn't be missed, `town` is
// only where to sleep while seeing it, `interest` names the traveler's own
// stated interest (or a phrase from their notes) that it serves, and
// `timeNeeded` is what the outline phase paces the day against. The town
// still matters — a sight with nowhere sensible to spend the night is not
// routable — it is just no longer the thing being chosen.
//
// lat/lng are NOT produced by Claude — they're resolved server-side after
// the response validates (generateRegionHighlights), so the review UI can
// draw the candidates on a map and estimate each one's detour off the
// ideal route. They are the SIGHT's coordinates, verified by name and
// distance against the base town (see locateCandidateSight in planTrip.ts):
// a named sight, unlike a town, routinely has no match where it was asked
// for, and Places answers that with a plausible namesake somewhere else
// entirely. Optional
// because resolution is best-effort — a sight that can't be located
// confidently must degrade to "no coordinates for this one" (and is then
// dropped rather than mapped to a guess), never to a failed generation.
// `source` is not produced by the highlights call either: it's stamped on
// server-side by the opt-in web-search enrichment pass so the review UI can
// show the traveler which suggestions came from a web search rather than
// the curated pass. Optional, and absent/undefined means 'curated' — every
// candidate produced before this feature existed (real trips mid-flight,
// existing tests) has to stay valid, and a candidate the plain highlights
// call returned is curated by definition.
export const regionHighlightCandidateSchema = z.object({
  // Required, because it is the whole point of this phase: a response that
  // lists towns without saying what is at them is the shape this replaced,
  // and failing it sends Claude back through callWithRetry's correct-and-
  // resubmit loop rather than silently reverting the design.
  // buildRegionHighlightsFromCandidates supplies the stop's own name here
  // for a town-only stop curated before this existed, so the reverse
  // direction never has to invent one.
  sight: z.string().min(1),
  /** Where to sleep while seeing `sight` — not itself the thing chosen. */
  town: z.string(),
  country: z.string().length(2),
  why: z.string(),
  priority: z.enum(['must-see', 'worth-a-detour', 'nice-if-convenient']),
  // Optional despite the prompt demanding both, because both must survive
  // the reverse direction: a stop the traveler pinned by hand, a rescan
  // find, or anything curated before this existed has no interest match and
  // no duration behind it, and guessing one would put a fabricated figure
  // straight into the pacing rules that read it.
  interest: z.string().optional(),
  // The shared enum rather than a second copy of the same three strings:
  // this value is written straight onto a corridorStop and read back off it,
  // so the two lists drifting apart would mean a candidate that validates
  // here and fails there.
  timeNeeded: sightTimeNeededSchema.optional(),
  // Google's own URL for the verified listing (see VerifiedPlace). Carried
  // from here onto the corridor stop so the card's link opens the place
  // rather than a bare pin at its coordinates.
  googleMapsUrl: z.string().optional(),
  source: z.enum(['curated', 'search']).optional(),
  lat: z.number().optional(),
  lng: z.number().optional(),
})

export const regionHighlightSchema = z.object({
  region: z.string(),
  country: z.string().length(2),
  reasoning: z.string(),
  // No .min(1): a genuinely trivial corridor (e.g. a short, local one-day
  // trip) can legitimately have nothing worth a special detour in a given
  // region — see HIGHLIGHTS_SYSTEM_PROMPT's own note on this. Forcing a
  // minimum used to mean the ONLY way to satisfy the schema on such a trip
  // was to retry into the same degenerate response and eventually fail the
  // whole call outright ("find great stops" reported as just not working).
  candidateStops: z.array(regionHighlightCandidateSchema),
})

export const regionHighlightsResponseSchema = z.object({
  // No .min(1) — see candidateStops' own comment just above; the same
  // failure mode applied at the whole-response level for a trip trivial
  // enough that no region has anything worth flagging at all.
  regions: z.array(regionHighlightSchema),
})

export type RegionHighlightCandidate = z.infer<
  typeof regionHighlightCandidateSchema
>
export type RegionHighlight = z.infer<typeof regionHighlightSchema>
export type RegionHighlightsResponse = z.infer<
  typeof regionHighlightsResponseSchema
>

// Phase 1 of planTrip's three-phase generation: just the route shape (which
// town each day overnights in, and the drive legs between them) for the
// WHOLE trip in one small call — this is where Claude solves the global
// routing/pacing problem (landing on the real end point by the real end
// date), while staying tiny regardless of trip length since it carries no
// activities/restaurants/blurbs.
export const routeOutlineDaySchema = z.object({
  index: z.number().int().nonnegative(),
  date: isoDate,
  type: z.enum(['drive', 'rest']),
  overnight: skeletonPointSchema,
  drive: skeletonDriveSchema.optional(),
  // Forces Claude to justify each stop against interests/notes rather than
  // defaulting to whichever town is geographically closest to the direct
  // line between startPoint and endPoint — see OUTLINE_SYSTEM_PROMPT.
  highlightReason: z.string().min(1),
  // The curated sights this day exists to see (2026-08-13). highlightReason
  // has always carried the same information in prose, and the detail phase
  // has always had a rule that a place NAMED in it must become one of the
  // day's activities — but that rule can only fire when the reason happens
  // to name the place cleanly, which is exactly the kind of thing a sentence
  // does unreliably. Naming them as a list makes the seam explicit: the
  // detail prompt is told these must appear among the day's activities,
  // verbatim. Optional, so a plain connecting overnight (a night that
  // exists to break up a drive, not to see anything) stays valid, and so an
  // outline generated before this existed still parses.
  sights: z.array(z.string()).optional(),
})

export const routeOutlineSchema = z.object({
  days: z.array(routeOutlineDaySchema).min(1),
})

export type RouteOutlineDay = z.infer<typeof routeOutlineDaySchema>
export type RouteOutline = z.infer<typeof routeOutlineSchema>

// Phase 2: per-chunk detail expansion. Claude is given the full outline for
// context but only asked to fill in activities/restaurants/blurbs for one
// chunk's days — it echoes back just the `index` to key each entry, not the
// route fields, so a detail call can never redirect the route the outline
// already committed to.
export const dayDetailSchema = z.object({
  index: z.number().int().nonnegative(),
  summary: z.string(),
  extraTimeReason: z.string().optional(),
  activities: z.array(skeletonActivitySchema).length(5),
  restaurants: z.array(skeletonRestaurantSchema).length(9),
})

export const chunkDetailResponseSchema = z.object({
  days: z.array(dayDetailSchema).min(1),
})

export type DayDetail = z.infer<typeof dayDetailSchema>
export type ChunkDetailResponse = z.infer<typeof chunkDetailResponseSchema>
