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
  // Interactive/transparent route planning (implemented 2026-07-27): a
  // 'full' plan request can opt into pausing after the highlights phase
  // (pure curation — candidate stops per region, no dates/pacing involved
  // yet) instead of generating straight through, so the traveler can
  // re-rank/remove candidates before the route is actually shaped.
  // Skippable — this status is only ever entered when requested.
  'awaiting-highlights-review',
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
  // Internal to generatePlan.ts — never read or rendered by the frontend.
  // Lets a retry after a failure resume from the last completed step
  // instead of re-running the whole (expensive) Claude + Places/Routes
  // pipeline from zero. `skeleton` is validated against
  // planTripSkeletonSchema server-side (that schema lives in
  // functions/src, not here, since it's an internal Claude-response shape,
  // not a cross-cutting app data model) — left loosely typed here.
  checkpoint: z
    .object({
      settingsHash: z.string(),
      skeleton: z.unknown(),
    })
    .optional(),
  // Set while status is 'awaiting-highlights-review' — the raw
  // RegionHighlightsResponse (regionHighlightsResponseSchema lives in
  // functions/src, same reasoning as checkpoint.skeleton above) for the
  // review UI to render and let the traveler edit before continuing.
  pendingHighlights: z.unknown().optional(),
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

// Overnight-stop type & candidate selection (implemented 2026-07-27):
// TripDay.overnight stays a single committed point (unchanged below) —
// switching overnight stops ripples into every following day's drive leg,
// so candidates are resolved lazily, on demand, and offered as a choice
// that (if taken) triggers a scoped replan rather than a client-side patch.
// Not stored on TripDay; returned directly by the getOvernightCandidates
// callable.
export const overnightStopCandidateSchema = z.object({
  name: z.string(),
  type: z.enum(['campsite', 'stellplatz', 'wild']),
  lat: z.number(),
  lng: z.number(),
  country: z.string().length(2),
  description: z.string(),
  // 'places' = Google Places (commercial campsites); 'osm' = OpenStreetMap
  // via Overpass (stellplatz — Places has weak-to-no coverage there); 'claude'
  // = Claude + web search (wild camping always, stellplatz only when OSM has
  // no coverage nearby) — surfaced in the UI so a traveler knows which
  // suggestions are Places/OSM-verified vs. AI-suggested and worth
  // double-checking locally.
  source: z.enum(['places', 'osm', 'claude']),
  // Only ever set for source: 'places' — a real Places listing URL. OSM and
  // Claude-sourced candidates have no equivalent, so the UI falls back to a
  // generic lat/lng Maps search link for those instead of leaving them
  // without a way to navigate there at all.
  googleMapsUrl: z.string().url().optional(),
})
export type OvernightStopCandidate = z.infer<typeof overnightStopCandidateSchema>

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
  highlightReason: z.string().optional(),
})

// Persistent, always-editable route corridor (2026-07-29): one entry per
// distinct overnight stop in the committed plan (consecutive rest days at
// the same stop share one entry via linkedDayIds), derived from the days
// actually written by generatePlan.ts/replanTrip.ts/insertRestDay.ts rather
// than from Claude's pre-selection highlight candidates — those have no
// stable identity (addressed purely positionally) and don't reliably map
// 1:1 to the days a generation finally produces. Everything the generation
// pipeline itself writes is 'committed' and always carries a real country
// (from TripDay.overnight) and at least one linkedDayId.
//
// Phase 3 (corridor editing + rescan, 2026-07-29) adds two more sources:
// a traveler manually pinning a stop on the map (status 'locked' —
// deliberate, no review step needed) and a "rescan this area" callable
// (status 'proposed' — a suggestion to review). Neither is backed by a
// TripDay, so both `country` and `linkedDayIds` had to loosen from the
// generation-only case: `country` is optional (a hand-placed pin has no
// geocoded country the way an overnight stop always does — Places
// autocomplete alone doesn't resolve one), and `linkedDayIds` may be empty
// (a stop with no day yet is exactly what "not yet reconciled into the
// plan" means — that reconciliation is phase 4's job, not this schema's).
export const corridorStopStatusSchema = z.enum([
  'proposed',
  'committed',
  'locked',
])

export const corridorStopSchema = z.object({
  name: z.string(),
  lat: z.number(),
  lng: z.number(),
  country: z.string().length(2).optional(),
  why: z.string().optional(),
  status: corridorStopStatusSchema,
  linkedDayIds: z.array(z.string()),
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
  photoUrl: z.string().url().optional(),
  priceLevel: z.number().int().min(0).max(4).optional(),
  cuisine: z.string().optional(),
  blurb: z.string(),
  status: itemStatusSchema,
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
  kind: z.enum(['full', 'replan', 'continueFromHighlights', 'insertRestDay']),
  replanContext: z
    .object({
      currentLocation: latLngSchema,
      today: isoDate,
      completedRefPaths: z.array(z.string()),
      remainingEndDate: isoDate,
      remainingEndPoint: namedPointSchema,
      changeRequestText: z.string().optional(),
      lockedDayIds: z.array(z.string()).optional(),
      // Set when this replan was triggered by the execution-mode "you're
      // behind plan" prompt (bug fix, reported 2026-07-27) — distinguishes
      // it from a voluntary "Request changes" edit so the outline phase can
      // be told the remainder's first day needs to be an easy catch-up day,
      // not paced the same as the rest of the remainder.
      behindScheduleKm: z.number().positive().optional(),
    })
    .optional(),
  // Set on an 'insertRestDay' request: the traveler wants to stay put one
  // extra day, so a rest day is inserted immediately after this day and
  // every later day shifts one calendar day back. Purely mechanical — no
  // Claude/Places call involved. afterDayId is a day doc ID (= its date).
  insertRestDayContext: z
    .object({
      afterDayId: z.string(),
    })
    .optional(),
  // Set on a 'full' request to pause after the highlights phase for review
  // instead of generating straight through — skippable, off by default.
  reviewHighlights: z.boolean().optional(),
  // Set on a 'full' request to run the opt-in web-search enrichment pass
  // between the highlights phase and the review pause: an extra Claude call
  // (with web search) looks for worthwhile stops near the already-curated
  // route that the knowledge-only first pass may have missed. Off by
  // default and costs real time, so the traveler asks for it explicitly —
  // and it only ever makes sense alongside reviewHighlights, since the whole
  // point is judging the finds before they're baked into a plan.
  searchForMoreStops: z.boolean().optional(),
  // Set on a 'continueFromHighlights' request: the traveler's edited
  // highlights (validated server-side against regionHighlightsResponseSchema
  // — see planMeta.checkpoint's comment for why it's untyped here) and an
  // optional note folded into notesFreeText for the outline/detail phases.
  editedHighlights: z.unknown().optional(),
  reviewNote: z.string().optional(),
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
export type CorridorStopStatus = z.infer<typeof corridorStopStatusSchema>
export type CorridorStop = z.infer<typeof corridorStopSchema>
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
