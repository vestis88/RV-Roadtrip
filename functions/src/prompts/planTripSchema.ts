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
