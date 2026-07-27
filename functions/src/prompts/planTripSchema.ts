import { z } from 'zod'
import { isoDate } from '@rv/shared'

const skeletonPointSchema = z.object({
  name: z.string(),
  town: z.string(),
  country: z.string().length(2),
  campsiteSuggestion: z.string().optional(),
})

const skeletonActivitySchema = z.object({
  name: z.string(),
  town: z.string(),
  category: z.enum(['sight', 'hike', 'museum', 'beach', 'playground', 'other']),
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
// lat/lng are NOT produced by Claude — they're geocoded server-side after
// the response validates (generateRegionHighlights), so the review UI can
// draw the candidates on a map and estimate each one's detour off the
// ideal route. Optional because geocoding is best-effort: a town that
// doesn't resolve, a transient Places error, or an unconfigured
// GOOGLE_PLACES_API_KEY must degrade to "no coordinates for this one",
// never to a failed trip generation.
export const regionHighlightCandidateSchema = z.object({
  town: z.string(),
  country: z.string().length(2),
  why: z.string(),
  priority: z.enum(['must-see', 'worth-a-detour', 'nice-if-convenient']),
  lat: z.number().optional(),
  lng: z.number().optional(),
})

export const regionHighlightSchema = z.object({
  region: z.string(),
  country: z.string().length(2),
  reasoning: z.string(),
  candidateStops: z.array(regionHighlightCandidateSchema).min(1),
})

export const regionHighlightsResponseSchema = z.object({
  regions: z.array(regionHighlightSchema).min(1),
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
