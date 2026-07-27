import { z } from 'zod'

export const isoDateTime = z.string().datetime({ offset: true })
export const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)

export const latLngSchema = z.object({
  lat: z.number(),
  lng: z.number(),
})

export const namedPointSchema = latLngSchema.extend({
  name: z.string(),
})

export const travelerSchema = z.object({
  name: z.string(),
  role: z.enum(['adult', 'child']),
  age: z.number().int().nonnegative().optional(),
})

export const fuelTypeSchema = z.enum(['diesel', 'petrol', 'electric', 'lpg'])

export const vehicleSchema = z.object({
  type: z.literal('RV'),
  weightKg: z.number().positive(),
  registeredAs: z.literal('car'),
  heightM: z.number().positive().optional(),
  lengthM: z.number().positive().optional(),
  widthM: z.number().positive().optional(),
  fuel: fuelTypeSchema.optional(),
})

export const tripSettingsSchema = z.object({
  startDate: isoDate,
  endDate: isoDate,
  startPoint: namedPointSchema,
  endPoint: namedPointSchema,
  travelers: z.array(travelerSchema),
  interests: z.array(z.string()),
  preferredCountries: z.array(z.string().length(2)),
  restDayFrequency: z.number().int().nonnegative(),
  maxDriveHoursPerDay: z.number().positive(),
  vehicle: vehicleSchema,
})

export const tripMetaSchema = z.object({
  name: z.string(),
  shareCode: z.string().length(6),
  createdAt: isoDateTime,
  version: z.number().int().nonnegative(),
})

export const tripNotesSchema = z.object({
  freeText: z.string(),
  updatedAt: isoDateTime,
})

export const planStatusSchema = z.enum([
  'idle',
  'pending',
  'generating',
  'ready',
  'error',
  'stale',
])

export const planMetaSchema = z.object({
  status: planStatusSchema,
  avgDriveMinutesPerDay: z.number().nonnegative().optional(),
  totalKm: z.number().nonnegative().optional(),
  generatedAt: isoDateTime.optional(),
  lastReplanAt: isoDateTime.optional(),
  error: z.string().optional(),
  // Human-readable step label during 'generating' (e.g. "Planning week 2 of
  // 4…") — set through the chunked planTrip() call and the Places/Routes
  // enrichment loop alike, so the UI always has something specific to show
  // instead of a single opaque "generating" spinner across the whole
  // multi-step pipeline.
  progressLabel: z.string().optional(),
  // Set once per-day resolution (Places/Routes enrichment) starts — the
  // slow, sequential tail end of generation the day-count progress bar is
  // for, once the route shape itself is known.
  progressCurrent: z.number().nonnegative().optional(),
  progressTotal: z.number().nonnegative().optional(),
})

export const tripSchema = z.object({
  meta: tripMetaSchema,
  settings: tripSettingsSchema,
  notes: tripNotesSchema,
  planMeta: planMetaSchema,
})

export const daySlotSchema = z.enum(['morning', 'midday', 'evening'])

export const overnightStopSchema = z.object({
  name: z.string(),
  lat: z.number(),
  lng: z.number(),
  country: z.string().length(2),
  campsiteSuggestion: z.string().optional(),
})

export const driveLegSchema = z.object({
  fromName: z.string(),
  toName: z.string(),
  distanceKm: z.number().nonnegative(),
  durationMin: z.number().nonnegative(),
  slot: daySlotSchema,
  polyline: z.string().optional(),
})

export const tripDaySchema = z.object({
  index: z.number().int().nonnegative(),
  date: isoDate,
  type: z.enum(['drive', 'rest']),
  overnight: overnightStopSchema,
  drive: driveLegSchema.optional(),
  summary: z.string(),
  extraTimeReason: z.string().optional(),
})

export const activityCategorySchema = z.enum([
  'sight',
  'hike',
  'museum',
  'beach',
  'playground',
  'other',
])

export const itemStatusSchema = z.enum([
  'suggested',
  'selected',
  'done',
  'skipped',
])

export const activitySchema = z.object({
  name: z.string(),
  category: activityCategorySchema,
  lat: z.number(),
  lng: z.number(),
  rating: z.number().min(0).max(5).optional(),
  ratingCount: z.number().int().nonnegative().optional(),
  googleMapsUrl: z.string().url().optional(),
  photoUrl: z.string().url().optional(),
  openingHours: z.array(z.string()).optional(),
  blurb: z.string(),
  kidFriendly: z.boolean(),
  status: itemStatusSchema,
  doneAt: isoDateTime.optional(),
  diaryNote: z.string().optional(),
})

export const mealSchema = z.enum(['breakfast', 'lunch', 'dinner'])

export const restaurantSchema = z.object({
  name: z.string(),
  meal: mealSchema,
  lat: z.number(),
  lng: z.number(),
  rating: z.number().min(0).max(5).optional(),
  ratingCount: z.number().int().nonnegative().optional(),
  googleMapsUrl: z.string().url().optional(),
  priceLevel: z.number().int().min(0).max(4).optional(),
  cuisine: z.string().optional(),
  blurb: z.string(),
  status: z.enum(['suggested', 'selected', 'done']),
  doneAt: isoDateTime.optional(),
  diaryNote: z.string().optional(),
})

export const roadFeesSchema = z.object({
  summary: z.string(),
  howToPay: z.string(),
  vignetteUrl: z.string().url().optional(),
})

export const speedLimitsSchema = z.object({
  urban: z.string(),
  rural: z.string(),
  motorway: z.string(),
  notes: z.string().optional(),
})

export const lpgInfoSchema = z.object({
  adapterNeeded: z.string(),
  commonBrands: z.array(z.string()),
  tips: z.string(),
})

export const countryGuideSchema = z.object({
  name: z.string(),
  drivingRules: z.array(z.string()),
  campingRules: z.array(z.string()),
  freeCampingRules: z.array(z.string()),
  roadFees: roadFeesSchema,
  speedLimits: speedLimitsSchema,
  lpgInfo: lpgInfoSchema,
  generatedAt: isoDateTime,
})

export const logEntrySchema = z.object({
  date: isoDate,
  refType: z.enum(['activity', 'restaurant']),
  refPath: z.string(),
  note: z.string().optional(),
  createdAt: isoDateTime,
})

export const planRequestSchema = z.object({
  tripId: z.string(),
  kind: z.enum(['full', 'replan']),
  replanContext: z
    .object({
      currentLocation: latLngSchema,
      today: isoDate,
      completedRefPaths: z.array(z.string()),
      remainingEndDate: isoDate,
      remainingEndPoint: namedPointSchema,
      changeRequestText: z.string().optional(),
      lockedDayIds: z.array(z.string()).optional(),
    })
    .optional(),
  status: z.enum(['pending', 'processing', 'done', 'error']),
  error: z.string().optional(),
})

export type LatLng = z.infer<typeof latLngSchema>
export type NamedPoint = z.infer<typeof namedPointSchema>
export type Traveler = z.infer<typeof travelerSchema>
export type FuelType = z.infer<typeof fuelTypeSchema>
export type Vehicle = z.infer<typeof vehicleSchema>
export type TripSettings = z.infer<typeof tripSettingsSchema>
export type TripMeta = z.infer<typeof tripMetaSchema>
export type TripNotes = z.infer<typeof tripNotesSchema>
export type PlanStatus = z.infer<typeof planStatusSchema>
export type PlanMeta = z.infer<typeof planMetaSchema>
export type Trip = z.infer<typeof tripSchema>
export type DaySlot = z.infer<typeof daySlotSchema>
export type OvernightStop = z.infer<typeof overnightStopSchema>
export type DriveLeg = z.infer<typeof driveLegSchema>
export type TripDay = z.infer<typeof tripDaySchema>
export type ActivityCategory = z.infer<typeof activityCategorySchema>
export type ItemStatus = z.infer<typeof itemStatusSchema>
export type Activity = z.infer<typeof activitySchema>
export type Meal = z.infer<typeof mealSchema>
export type Restaurant = z.infer<typeof restaurantSchema>
export type RoadFees = z.infer<typeof roadFeesSchema>
export type SpeedLimits = z.infer<typeof speedLimitsSchema>
export type LpgInfo = z.infer<typeof lpgInfoSchema>
export type CountryGuide = z.infer<typeof countryGuideSchema>
export type LogEntry = z.infer<typeof logEntrySchema>
export type PlanRequest = z.infer<typeof planRequestSchema>
