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
  activities: z.array(skeletonActivitySchema).length(5),
  restaurants: z.array(skeletonRestaurantSchema).length(9),
})

export const planTripSkeletonSchema = z.object({
  days: z.array(planTripSkeletonDaySchema).min(1),
})

export type PlanTripSkeletonDay = z.infer<typeof planTripSkeletonDaySchema>
export type PlanTripSkeleton = z.infer<typeof planTripSkeletonSchema>

// Phase 1 of planTrip's two-phase generation: just the route shape (which
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
