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
  // How many nights in a row may be spent off grid before the plan has to
  // put the RV somewhere with facilities again. Optional because every trip
  // that existed before this setting did has to keep validating — read it
  // through offGridToleranceOf(), never with a `?? 3` at the call site.
  offGridTolerance: z.number().int().nonnegative().optional(),
  // How many days ahead get their activities and restaurants worked out —
  // the rolling detail window. See DEFAULT_DETAIL_WINDOW_DAYS. Optional for
  // the same reason as offGridTolerance, and read the same way, through
  // detailWindowDaysOf().
  detailWindowDays: z.number().int().positive().optional(),
  vehicle: vehicleSchema,
})

/**
 * The traveler's own "off grid for a couple of days easily", rounded up.
 *
 * This is a tank number, not a taste number: what actually ends a run of
 * free nights is fresh water running out and grey/black filling up, so the
 * setting is expressed in consecutive nights without a service point and
 * NOT as a share of the trip. 0 means never commit a night to a free spot.
 */
export const DEFAULT_OFF_GRID_TOLERANCE = 3

/**
 * The one place the default is applied. Takes a bare shape rather than
 * TripSettings so it can also be handed a partially-built settings object
 * (the trip-creation defaults, a settings patch) without a cast.
 */
export function offGridToleranceOf(settings: {
  offGridTolerance?: number
}): number {
  return settings.offGridTolerance ?? DEFAULT_OFF_GRID_TOLERANCE
}

/**
 * How many days ahead are worked out in full — the rolling detail window.
 *
 * Three is what a traveler can usually act on: today, tomorrow, the day
 * after. It is a default rather than a rule because the right answer is a
 * matter of taste and of how the trip is being used — someone booking
 * restaurants a week out wants a week, someone improvising wants tomorrow —
 * so Trip Setup exposes it (2026-08-17, "I want the option to decide how
 * many days ahead it should plan").
 *
 * The route is NOT affected: the whole trip is routed either way. This only
 * decides how far ahead the activities and restaurants are resolved, which
 * is the part that costs a Claude call and a run of Places lookups per day
 * — and the part a replan throws away and pays for again.
 */
export const DEFAULT_DETAIL_WINDOW_DAYS = 3

/**
 * The ceiling on that window.
 *
 * Two weeks, not "the whole trip". Past this the window stops being a window
 * and becomes the thing the split was built to stop: a sixty-day trip
 * detailing sixty days up front, and re-detailing the whole remainder on
 * every replan. It is also the bound the detailDays callable validates
 * against, so a hand-written request cannot ask for a hundred days.
 */
export const MAX_DETAIL_WINDOW_DAYS = 14

/**
 * The one place the default and the bounds are applied. Clamped rather than
 * trusted: this number sizes paid work, and it arrives from a client write.
 */
export function detailWindowDaysOf(settings: {
  detailWindowDays?: number
}): number {
  const chosen = settings.detailWindowDays ?? DEFAULT_DETAIL_WINDOW_DAYS
  return Math.min(Math.max(Math.round(chosen), 1), MAX_DETAIL_WINDOW_DAYS)
}

/**
 * A country the traveler chose that the last curation pass came back empty
 * for, and which kind of empty it was.
 *
 * Lives here rather than in functions/ because it is written onto the trip
 * (planMeta.exploreLastEmptyCountries) and read by the map — the callable's
 * return value is no longer its only route to a screen. The reasons are worth
 * telling apart because their fixes are completely different: nothing was
 * suggested there, versus things were suggested and none of them could be
 * found on the map.
 */
export const emptyCountrySchema = z.object({
  country: z.string().length(2),
  reason: z.enum(['not-proposed', 'not-located']),
  /** How many sights were proposed there — 0 when the reason is not-proposed. */
  proposed: z.number().int().nonnegative(),
  /** Curation's own explanation for the gap, when it gave one. */
  note: z.string().optional(),
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
  // Advisory only, written by pacingValidator.pacingWarnings(): the point at
  // which the distance still to drive has got furthest ahead of the drive
  // days left to do it in. Deliberately not an `error` — the plan is valid
  // and usable, and whether the early stops were worth what they cost the
  // end of the trip is the traveler's call, not something to fail a
  // generation over. Absent (rather than an empty array) when there's
  // nothing to say.
  pacingWarnings: z.array(z.string()).optional(),
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
  // Explore mode's own busy guard (2026-07-30) — deliberately separate from
  // `status` above: running the cheap highlights-only curation must not
  // flip the trip out of 'idle' (that's what keeps the Map tab showing the
  // explore screen instead of a "generating" banner), but two devices on a
  // shared trip clicking "Find great stops" at the same moment still
  // shouldn't both pay for the call. Absent/'idle' outside a run.
  exploreStatus: z.enum(['idle', 'generating']).optional(),
  // Set whenever exploreStatus flips to 'generating' — lets a stuck lock
  // (the function's container killed by its own timeout, or crashed, before
  // the `finally` that resets exploreStatus could run) be reclaimed after a
  // grace period instead of leaving "Generate overview" permanently
  // failing with "Already finding great stops" for that trip. See
  // exploreHighlightsCallable.ts's STALE_EXPLORE_LOCK_MS.
  exploreStatusUpdatedAt: isoDateTime.optional(),
  // Set once a run of generateExploreHighlights actually completes (not on
  // a failed attempt) — lets the Map screen tell "never searched yet" apart
  // from "searched and genuinely found nothing" regardless of which screen
  // fired the call. Local component state can't do this: "Generate
  // overview" (Trip Setup) navigates to /map on success, so ExploreMapScreen
  // mounts fresh with no memory of the search that just ran — the exact
  // primary entry point this distinction exists for.
  exploreLastRunAt: isoDateTime.optional(),
  // Which settings have changed since this plan was generated — the reason
  // it is `stale`, recorded rather than inferred (2026-08-19).
  //
  // Staleness on its own says "something no longer matches" and nothing
  // about what, which is enough to offer a rebuild and not enough to offer
  // anything cheaper. Shifting a plan's dates, for instance, fully answers a
  // date change and answers nothing about a changed drive-hours ceiling, so
  // whether that shortcut is honest depends entirely on what actually
  // changed. Written with arrayUnion, so two edits before one regeneration
  // both land; cleared wherever a plan reaches 'ready'.
  staleSettings: z.array(z.string()).optional(),
  // The chosen countries that last came back with nothing, and which kind of
  // nothing it was — see functions/src/countryCoverage.ts.
  //
  // Kept on the trip for exactly the reason exploreLastRunAt is: "Generate
  // overview" navigates to /map on success, so the screen that has to explain
  // the result is a fresh mount of a component that never made the call. That
  // is the app's PRIMARY entry point into this search, and it was the one
  // where the explanation was computed, returned, and then dropped on the
  // floor — leaving the map to say "nothing stood out along this route" about
  // a trip crossing half of Europe, with the reason (an inherited country
  // list that named none of the countries it drives through) visible nowhere.
  // Rewritten by every completed run, so it always describes the newest one.
  exploreLastEmptyCountries: z.array(emptyCountrySchema).optional(),
  // Why the last "Generate overview" / "Find great stops" run failed, in one
  // line, written where it survives the connection that started it.
  //
  // The rescan path was given this on 2026-08-16 and this one — the older and
  // more used of the two — was left without it, so the two searches failed
  // very differently: a failed rescan says what broke, a failed overview says
  // "please try again" and the reason dies with the promise on the phone.
  // That is not a hypothetical: a run reported on 2026-08-17 showed exactly
  // the generic line with the trip already back at idle, and there was no
  // record anywhere of what it had hit. A search is a fact about the trip
  // (see exploreStatus above) and so is its failure. Cleared on success.
  exploreLastError: z.string().optional(),
  exploreLastFailedAt: isoDateTime.optional(),
  // "Rescan this area" progress, kept on the trip rather than in the button's
  // own state (2026-08-16). Reported as "changing tab during a rescan breaks
  // the search": the search itself was fine — corridorStops is a live
  // subscription, so anything it found still arrived — but the component
  // holding the in-flight promise unmounts on a tab change, taking the
  // "Scanning…" state and the "found N stops" confirmation with it. What the
  // traveler saw was an idle button and no answer, which reads as a search
  // that died, and invites pressing it again for a second paid Claude call.
  //
  // Same shape and the same reasoning as exploreStatus above, including the
  // heartbeat that lets a lock abandoned by a killed container be recognised
  // as stale rather than trusted forever.
  rescanStatus: z.enum(['idle', 'generating']).optional(),
  // A genuine heartbeat: refreshed every few seconds for as long as the
  // function is alive, not written once at the start. Written once, it could
  // not tell "still searching" apart from "the container died four minutes
  // ago", which is why a stuck scan had to be given a six-minute benefit of
  // the doubt before the button would come back. See RESCAN_HEARTBEAT_MS.
  rescanStatusUpdatedAt: isoDateTime.optional(),
  // When the running scan actually began. Separate from the heartbeat
  // because the two are read for opposite purposes — this one is the
  // traveler's elapsed counter, which must not reset every time the server
  // says "still here".
  rescanStartedAt: isoDateTime.optional(),
  // Why the last rescan failed, in one line, written where it survives the
  // connection that started the scan.
  //
  // The reason three rescan failures in a row were diagnosed by guesswork:
  // the cause existed only in the rejected promise on the traveler's phone,
  // and a phone that had stopped following the call never saw it either. A
  // scan is a fact about the trip (see rescanStatus above) and so is its
  // failure. Cleared whenever a scan succeeds.
  rescanLastError: z.string().optional(),
  rescanLastFailedAt: isoDateTime.optional(),
  // Set when a rescan finishes, with what it found — so the confirmation
  // survives the round trip through Firestore instead of living only in the
  // component that started it.
  rescanLastRunAt: isoDateTime.optional(),
  rescanLastFoundCount: z.number().int().nonnegative().optional(),
  // Real places the search found, geocoded successfully, and then discarded
  // for sitting outside the area it was told to search. Recorded because
  // "Nothing new found nearby" was being said in exactly this case, which
  // describes a different failure from the one that happened and is what
  // made a narrow search look like a broken one.
  rescanLastDroppedTooFar: z.number().int().nonnegative().optional(),
  // How big the circle actually searched was, in kilometres.
  //
  // "Rescan this area" searches a circle around the map's centre, capped at
  // MAX_RESCAN_RADIUS_KM — so on any view wider than about 100 km across, the
  // area searched is a fraction of the area on screen, and nothing used to
  // say so. Reported from a map showing the whole of Lithuania that answered
  // "found 2 places, but they were outside the area searched": both were in
  // view, neither was within 50 km of the centre. Stored with the run so the
  // result can name the circle it is talking about.
  rescanLastRadiusKm: z.number().positive().optional(),
  // Places the search proposed that could not be found on the map at all.
  // Recorded apart from the count above because the two mean opposite
  // things: "the area you searched was too narrow" versus "these could not
  // be verified", the second of which points at map data rather than at the
  // search. Both used to read as "Nothing new found nearby".
  rescanLastNotLocated: z.number().int().nonnegative().optional(),
  // Heartbeat for the `status` busy guard — refreshed whenever a running
  // generation writes progress, so a claim left behind by a killed
  // container can be reclaimed instead of wedging the trip forever. See
  // functions/src/planLock.ts.
  statusUpdatedAt: isoDateTime.optional(),
  // Set when a plan operation finishes, success or failure. The watermark
  // that makes duplicate submissions impossible rather than merely unlikely:
  // a planRequest committed before this instant was aimed at a plan that no
  // longer exists, so generatePlan refuses it no matter when its trigger
  // happens to fire. Internal to the backend — never read or rendered by the
  // frontend. See functions/src/planLock.ts's wasSubmittedBeforeRunEnded.
  lastRunEndedAt: isoDateTime.optional(),
})

export const tripSchema = z.object({
  meta: tripMetaSchema,
  settings: tripSettingsSchema,
  notes: tripNotesSchema,
  planMeta: planMetaSchema,
})

export const daySlotSchema = z.enum(['morning', 'midday', 'evening'])

export const overnightStopTypeSchema = z.enum(['campsite', 'stellplatz', 'wild'])

export const overnightStopSchema = z.object({
  name: z.string(),
  lat: z.number(),
  lng: z.number(),
  country: z.string().length(2),
  campsiteSuggestion: z.string().optional(),
  // What kind of place the night is actually committed to, once
  // applyOvernightOptions has moved the overnight off the town centre. Absent
  // on a day still sitting on its town point, and on days written before the
  // planner was allowed to choose a free night at all.
  type: overnightStopTypeSchema.optional(),
  // Only ever set on a 'wild' night: the sentence from THIS country's own
  // researched free-camping rules that made the night permissible. Recorded
  // per day rather than left in the country guide because "why is it legal to
  // sleep here" is a question asked at the roadside, about one night, and
  // because the rules can be re-researched afterwards — this is what the plan
  // was actually decided on.
  freeCampingRule: z.string().optional(),
  // Google's own URL for the committed stop, when it came from Places (a
  // commercial campsite). Absent for an OSM stellplatz or a free spot, which
  // genuinely have no Google listing — there the coordinate link is the right
  // answer rather than a degraded one, since what is being navigated to is a
  // point in a lay-by and not a business.
  googleMapsUrl: z.string().optional(),
  /**
   * Where this stop sits in the driving order, for a `locked` stop only
   * (2026-08-17).
   *
   * The explore map used to order kept stops by projecting them onto the
   * straight start→end line, which cannot know the sea is in the way: it put
   * a stop in northern Sweden ahead of one on Saaremaa, and the only road
   * answer to that sequence was around the Gulf of Bothnia. Google orders
   * them against real roads now — and this is where that answer is kept, so
   * it survives pressing "Generate full plan".
   *
   * Without it the order lived in React state and died at the moment it
   * mattered most: the plan request carries nothing but a trip id, so the
   * route phase re-derived the sequence from scratch and put the detour
   * straight back.
   *
   * Distinct from `rank`, which orders CANDIDATES within a priority tier —
   * a different question about a different set of stops.
   */
  routeIndex: z.number().int().nonnegative().optional(),
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
  type: overnightStopTypeSchema,
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
  /**
   * Set when this leg's distance and time are a straight-line ESTIMATE
   * rather than a real route (2026-08-17).
   *
   * computeRouteLeg falls back to a haversine estimate whenever the Routes
   * API has no key or fails, so a plan can carry numbers that were never
   * driveable — across water, most obviously — while reading exactly like
   * measured ones. They also feed pacing validation, so a fictional short
   * leg can make a bad route look well paced. Recorded so the day can say so
   * instead of presenting a guess as a measurement.
   */
  estimated: z.boolean().optional(),
})

export const tripDaySchema = z.object({
  index: z.number().int().nonnegative(),
  date: isoDate,
  type: z.enum(['drive', 'rest']),
  overnight: overnightStopSchema,
  // Where the day's TOWN is, as opposed to where the day sleeps. The two
  // separated once the overnight moved off the town centre and onto an
  // actual campsite/stellplatz, which can be up to 20km outside it. Kept so
  // re-resolving overnight options searches around the town again instead of
  // around the last site it picked — otherwise each re-run would drift a
  // little further out. Absent on days written before this existed, where
  // the overnight IS the town point.
  townAnchor: latLngSchema.optional(),
  drive: driveLegSchema.optional(),
  summary: z.string(),
  extraTimeReason: z.string().optional(),
  highlightReason: z.string().optional(),
  // The curated sights this day was routed for, carried down from the route
  // outline (see routeOutlineDaySchema.sights). The day's activities already
  // contain them by name, but as five entries with no marker saying which
  // two are the reason the trip comes here at all — so pacing cannot tell a
  // day built around a full-day castle from a day with five nearby
  // diversions. Absent on a plain connecting overnight, and on every day
  // written before this existed.
  sights: z.array(z.string()).optional(),
  /**
   * Whether this day's activities and restaurants have been worked out yet
   * (2026-08-16, "route eagerly, detail lazily").
   *
   * The route is a whole-trip constraint problem — where you sleep on day 12
   * depends on everything before and after it — so it is still solved for
   * every day up front. A day's activities and restaurants are not: they
   * depend on nothing outside that day, and producing sixty days of them at
   * generation is paid for again in full on every replan, which re-details
   * the entire remainder of the trip to change one week.
   *
   * ABSENT MEANS READY. Every day written before this existed carries its
   * detail already, and a trip planned last week must not come back looking
   * like it lost half of itself.
   */
  detailStatus: z.enum(['pending', 'generating', 'ready']).optional(),
  /**
   * Heartbeat while detail is being worked out, refreshed for as long as the
   * function is alive — not written once at the start. A single timestamp
   * cannot tell a slow run from a container that died two minutes ago, which
   * is how a spinner ends up on screen forever. See detailDaysCallable.ts.
   */
  detailStatusUpdatedAt: isoDateTime.optional(),
  /**
   * Why the last attempt to detail this day failed, kept where it outlives
   * the connection that asked for it. Cleared when detail succeeds.
   */
  detailError: z.string().optional(),
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
//
// Explore mode (2026-07-30) adds a fifth source and a fifth status:
// 'candidate', a suggestion from the cheap, repeatable highlights-only
// curation (or a rescan run before any plan exists) that a traveler hasn't
// weighed in on yet — distinct from 'proposed', which specifically means "a
// rescan finding on an already-generated trip." A candidate carries
// `priority` (Claude's own must-see/worth-a-detour/nice-if-convenient
// call), `region` (its source region label, for grouping in the explore
// list — absent for a rescan find, which has no region context), and `rank`
// (position within its priority tier, swapped pairwise by the up/down vote
// buttons — tiers are compared independently, not against each other).
// Committing explore mode reads every 'candidate' and 'locked' stop back
// into a highlights payload for the real generation to seed from (see
// buildRegionHighlightsFromCandidates in functions/src/exploreCandidates.ts)
// — 'locked' already means "the traveler wants this in the route" whether
// it came from explore mode or a manual pin, so both count.
//
// 'rejected' (2026-08-13) is a sixth status and exists purely so a refresh
// can be a merge. "Not interested" used to delete the doc, which was fine
// while a refresh replaced the whole candidate set anyway; now that a
// refresh keeps what's already there and only adds what's new, a deleted
// stop is indistinguishable from one that was never proposed, so the very
// next "Find more stops" would hand the traveler back everything they had
// just turned down. A rejected stop is a tombstone: hidden everywhere a
// candidate is shown, never seeded into a generation, and matched against
// so the same place is not proposed twice.
export const corridorStopStatusSchema = z.enum([
  'proposed',
  'committed',
  'locked',
  'candidate',
  'rejected',
])

export const corridorStopPrioritySchema = z.enum([
  'must-see',
  'worth-a-detour',
  'nice-if-convenient',
])

/**
 * Roughly how much of a day a sight takes. Three buckets rather than a
 * number of hours, because that is the honest resolution of the estimate and
 * because it is what the routing actually needs: a full-day sight is a day
 * that cannot also be a long drive.
 */
export const sightTimeNeededSchema = z.enum([
  'couple-of-hours',
  'half-day',
  'full-day',
])

export const corridorStopSchema = z.object({
  // For a sight-led candidate (2026-08-13, see below) this is the SIGHT's
  // own name and coordinates, not the town's — the sight is what the
  // traveler is deciding on, what the map pin should point at, and what the
  // detour estimate should be measured to.
  name: z.string(),
  lat: z.number(),
  lng: z.number(),
  country: z.string().length(2).optional(),
  why: z.string().optional(),
  status: corridorStopStatusSchema,
  linkedDayIds: z.array(z.string()),
  // Explore-mode-only fields (see the doc comment above) — undefined for
  // every other status.
  priority: corridorStopPrioritySchema.optional(),
  region: z.string().optional(),
  rank: z.number().optional(),
  // Sights-led curation (2026-08-13). Curation now answers "what shouldn't
  // we miss", so a candidate is a sight/activity with a town attached to
  // sleep in, rather than a town with a reason attached. All three are
  // optional and stay that way: every stop written before this existed is a
  // town whose own name is the whole story (`baseTown` undefined means "this
  // IS the place"), and a hand-dropped pin or a rescan find has no interest
  // or duration behind it either.
  //
  // `baseTown` is the nearest sensible town to sleep in — the outline phase
  // derives overnights from it. `interest` is the traveler's own stated
  // interest (or a phrase from their notes) that this sight serves, so the
  // match is visible on the card instead of something they take on trust.
  // `timeNeeded` feeds pacing: see sightTimeNeededSchema.
  baseTown: z.string().optional(),
  interest: z.string().optional(),
  timeNeeded: sightTimeNeededSchema.optional(),
  // Google's own URL for this place's listing, when it was verified through
  // Places. Present so "Open in Google Maps" lands on the place — with its
  // name, photos and opening hours — instead of dropping a nameless pin at
  // its coordinates, which is what a coordinate link does and what was
  // reported. Absent for a hand-dropped pin or anything not verified, where
  // the coordinate link is the honest answer rather than a worse one.
  googleMapsUrl: z.string().optional(),
  // Google's own photo of that listing (2026-08-17). The search that verified
  // the place already returned it — FIELD_MASK asks for places.photos — and
  // verifyPlaceLocation was discarding it, the same way it used to discard
  // the name and the URL.
  //
  // Worth carrying because of where these cards sit: every activity and
  // restaurant in the day-by-day plan has had a photo since PlaceCard
  // existed, and the explore list — the screen where the traveler actually
  // decides whether a place is worth driving hours for — had none. Absent
  // for a hand-dropped pin, for a listing with no photo, and for every stop
  // curated before this existed.
  photoUrl: z.string().url().optional(),
  /**
   * Who put this stop on the trip (2026-08-19).
   *
   * 'traveler' — curated in explore mode, found by a rescan, or pinned by
   * hand. This is research: it cost a Claude call or a deliberate decision,
   * and a regeneration must not throw it away.
   * 'plan' — minted by generation itself, one per distinct overnight town
   * (see buildCorridorStopWrites). It describes the plan that exists, so a
   * regeneration replacing that plan should replace it too.
   *
   * Needed because the two are otherwise indistinguishable. A hand-dropped
   * pin writes exactly the fields a generated overnight town does — name,
   * coordinates, country, why — so no amount of field-sniffing separates
   * them, and the `committed` status they both end up in says only "this is
   * in the itinerary", not where it came from.
   *
   * ABSENT MEANS 'plan' wherever that distinction decides a deletion. Every
   * stop written before this field existed carries nothing, and the
   * conservative reading keeps those trips behaving exactly as they did
   * rather than resurrecting stops nobody asked to keep.
   */
  origin: z.enum(['traveler', 'plan']).optional(),
  /**
   * How long the traveler intends to stay (2026-08-23).
   *
   * Requested: "I want to be able to state how long we intend to stay at
   * that activity/stop. This will yield a total duration that we can then
   * simply curate ourselves by locking/unlocking stops."
   *
   * Two shapes rather than a number of hours, because RV travel mixes two
   * genuinely different things and a total that cannot tell them apart is
   * useless. A viewpoint is an hour; a lake you park beside is three
   * NIGHTS, and entering that as 72 hours both reads wrong and packs wrong —
   * nights consume days without consuming driving budget, hours compete
   * with the drive for the same day.
   *
   * ABSENT MEANS "derive it from `timeNeeded`" (see stayHoursOf), so every
   * stop curated before this existed already has a sensible answer and
   * nothing had to be backfilled.
   */
  stayDuration: z
    .union([
      z.object({ kind: z.literal('hours'), hours: z.number().positive() }),
      z.object({
        kind: z.literal('nights'),
        nights: z.number().int().positive(),
      }),
    ])
    .optional(),
})

/** Hours a sight needs when nobody has said otherwise — see stayDuration. */
export const TIME_NEEDED_HOURS: Record<SightTimeNeeded, number> = {
  'couple-of-hours': 2,
  'half-day': 4,
  'full-day': 8,
}

/**
 * What a stop costs the trip, in hours of daylight and in nights.
 *
 * The single place the "absent means derive it" rule lives, so the budget,
 * the card and any future caller cannot disagree about what an unset
 * duration means. A `nights` stay reports zero hours deliberately: its cost
 * is whole days, counted separately, not daytime competing with the drive.
 */
export function stayCostOf(stop: {
  stayDuration?: CorridorStop['stayDuration']
  timeNeeded?: SightTimeNeeded
}): { hours: number; nights: number } {
  const duration = stop.stayDuration
  if (duration?.kind === 'nights') return { hours: 0, nights: duration.nights }
  if (duration?.kind === 'hours') return { hours: duration.hours, nights: 0 }
  return { hours: TIME_NEEDED_HOURS[stop.timeNeeded ?? 'half-day'], nights: 0 }
}

// Phase 4a (reorder/date-shift reconciliation, 2026-07-29): one entry per
// day whose date actually moved when the traveler's proposed new stop order
// was reconciled against the existing day sequence. Returned by both the
// dry-run preview callable and the real commit, so the same diff a traveler
// reviewed before confirming is exactly what happened.
export const reconcileDayChangeSchema = z.object({
  dayId: z.string(),
  overnightName: z.string(),
  oldDate: isoDate,
  newDate: isoDate,
  newDistanceKm: z.number().nonnegative().optional(),
  newDurationMin: z.number().nonnegative().optional(),
})

export const activityCategorySchema = z.enum([
  'sight',
  'hike',
  'museum',
  'beach',
  'playground',
  // Places people travel TO DO something, rather than to look at (added
  // 2026-08-15). Reported as "a search focused on downhill returned none of
  // the big resorts": with no category for either, a bike park or a ski area
  // could only be filed as 'other', which sends no type filter at all to the
  // nearby search — so a day at a resort was backfilled with whatever museums
  // and playgrounds happened to be within 30 km.
  'bike',
  'ski',
  'other',
])

export const itemStatusSchema = z.enum([
  'suggested',
  'selected',
  'done',
  'skipped',
])

// Traveler-set, not generated: picked when selecting an activity (see
// PlaceCard's time-of-day control), so the day's route can be sequenced
// through breakfast/morning-activity/lunch/evening-activity/dinner/
// night-activity/overnight in a sensible order rather than an arbitrary one.
// Absent (or 'all-day') means "no particular slot" — every activity selected
// before this feature existed, and every activity a traveler doesn't bother
// tagging, still counts as a route waypoint, just without a specific slot to
// sort it into.
export const activityTimeOfDaySchema = z.enum([
  'morning',
  'evening',
  'night',
  'all-day',
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
  timeOfDay: activityTimeOfDaySchema.optional(),
  // Dismiss-and-requeue (implemented 2026-07-30): generation resolves a
  // couple of extra activities/restaurants beyond the displayed count and
  // stores them with `reserve: true` — invisible to every UI consumer
  // (useDayDetail filters them out) until a traveler skips a displayed one
  // and there's nothing left to show, at which point the client promotes a
  // reserve item in place (flips this to false/absent) rather than leaving a
  // gap or making the traveler wait on a live Places round-trip. Absent
  // means false — every pre-existing activity (and everything written by
  // paths that don't know about reserves, e.g. AddCustomStopForm) is a real,
  // displayed item by default.
  reserve: z.boolean().optional(),
  // Nobody chose this place for this trip: Places found it by category
  // ("a well-rated museum near here") rather than by name, either because
  // the plan's own suggestion couldn't be verified or because the traveler
  // asked for more options than the plan proposed.
  //
  // It exists because the two used to be indistinguishable on screen, in the
  // worst possible way: when a named lookup failed, the nearby fallback's
  // result was written out carrying the ORIGINAL suggestion's blurb, so a
  // shopping centre with 9,125 reviews was served as lunch under the words
  // "Charming lakeside café near the castle". Substitutes now get a generic
  // blurb of their own and this flag, and PlaceCard labels them — "we found
  // the place the plan meant" and "we couldn't, here's a top-rated
  // alternative" are different claims and should read differently. Absent
  // means false: everything predating this, and everything a traveler adds
  // by hand, is a real pick.
  substitute: z.boolean().optional(),
  // The Places (New) place ID the item resolved to — internal-use only,
  // never rendered. Lets a later "research more alternatives" call (once
  // both the displayed item AND its reserve are exhausted) exclude every
  // place already shown or already dismissed for this day, not just the
  // ones from its own single generation pass. Optional because it didn't
  // exist before this feature — older items simply can't be excluded by ID,
  // a known, acceptable v1 gap.
  placeId: z.string().optional(),
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
  // See activitySchema's own comment — same dismiss-and-requeue mechanism.
  reserve: z.boolean().optional(),
  // See activitySchema's own comment. The reported case was a restaurant:
  // "BIG Shopping", a shopping centre, offered for lunch.
  substitute: z.boolean().optional(),
  placeId: z.string().optional(),
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

/**
 * One section of the country research brief — the editable "what should I
 * look up for every country" list (see countryBrief.ts for the defaults and
 * for how dependsOnVehicle decides cache scope).
 */
export const countryBriefSectionSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  brief: z.string().min(1),
  dependsOnVehicle: z.boolean(),
})

export const countryBriefSchema = z.object({
  sections: z.array(countryBriefSectionSchema),
  updatedAt: isoDateTime,
})

/**
 * One researched section, stored OUTSIDE any trip (`countryGuideSections`)
 * so the same research serves every trip that needs it. The doc ID carries
 * the country, the section, the brief's hash and — for vehicle-dependent
 * sections — the vehicle, so a cache hit is always safe to reuse; see
 * countryGuideSectionDocId.
 */
export const countryGuideSectionSchema = z.object({
  countryCode: z.string().length(2),
  sectionId: z.string(),
  title: z.string(),
  items: z.array(z.string()),
  sources: z.array(z.string()),
  generatedAt: isoDateTime,
})

export const logEntrySchema = z.object({
  date: isoDate,
  refType: z.enum(['activity', 'restaurant']),
  refPath: z.string(),
  note: z.string().optional(),
  createdAt: isoDateTime,
})

// Family share links (2026-08-02): the read-only projection a guest holding
// a share token receives from the viewSharedTrip endpoint. Deliberately its
// own set of schemas rather than reusing Trip/TripDay/Activity/... — this is
// the one payload in the app that crosses the trust boundary to someone who
// is not a member and is not even signed in, so every field a viewer gets is
// written out here by hand. The field that must never appear is
// meta.shareCode: that is the EDITOR invite code (joinTrip grants full
// read/write on the trip to whoever types it), so a viewer holding it would
// have exactly the access the share link exists to withhold. Spreading a
// Trip would leak it today and leak whatever private field gets added to
// Trip tomorrow; listing fields explicitly fails closed instead.
export const sharedTripPlaceSchema = z.object({
  id: z.string(),
  name: z.string(),
  blurb: z.string(),
  status: itemStatusSchema,
  category: activityCategorySchema.optional(),
  timeOfDay: activityTimeOfDaySchema.optional(),
  meal: mealSchema.optional(),
  rating: z.number().min(0).max(5).optional(),
  ratingCount: z.number().int().nonnegative().optional(),
  photoUrl: z.string().url().optional(),
  googleMapsUrl: z.string().url().optional(),
})

export const sharedTripDaySchema = z.object({
  id: z.string(),
  index: z.number().int().nonnegative(),
  date: isoDate,
  type: z.enum(['drive', 'rest']),
  summary: z.string(),
  highlightReason: z.string().optional(),
  overnight: overnightStopSchema,
  drive: driveLegSchema.optional(),
  activities: z.array(sharedTripPlaceSchema),
  restaurants: z.array(sharedTripPlaceSchema),
})

export const sharedTripStopSchema = z.object({
  id: z.string(),
  name: z.string(),
  lat: z.number(),
  lng: z.number(),
  country: z.string().length(2).optional(),
  why: z.string().optional(),
  status: corridorStopStatusSchema,
})

/**
 * A diary entry as a guest sees it. `placeName` is resolved server-side
 * because `refPath` points into `trips/{id}/days/...`, which no guest can
 * read — the in-app DiaryScreen resolves the same name with its own
 * client-side getDoc, an option only a signed-in member has.
 */
export const sharedTripDiaryEntrySchema = z.object({
  id: z.string(),
  date: isoDate,
  refType: z.enum(['activity', 'restaurant']),
  placeName: z.string(),
  note: z.string().optional(),
  createdAt: isoDateTime,
})

export const sharedTripViewSchema = z.object({
  trip: z.object({
    name: z.string(),
    startDate: isoDate,
    endDate: isoDate,
    startPoint: namedPointSchema,
    endPoint: namedPointSchema,
    planStatus: planStatusSchema,
    totalKm: z.number().nonnegative().optional(),
    avgDriveMinutesPerDay: z.number().nonnegative().optional(),
    generatedAt: isoDateTime.optional(),
  }),
  days: z.array(sharedTripDaySchema),
  corridorStops: z.array(sharedTripStopSchema),
  diary: z.array(sharedTripDiaryEntrySchema),
  /** When the server read this — the view is live, not a stored snapshot. */
  fetchedAt: isoDateTime,
})

export const planRequestSchema = z.object({
  tripId: z.string(),
  kind: z.enum(['full', 'replan', 'insertRestDay', 'reconcileCorridor']),
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
  // Set on a 'reconcileCorridor' request: the traveler edited the corridor
  // (reordered via up/down buttons, no drag-and-drop — see
  // corridorReconciliation.ts's own comment for why; or included/excluded a
  // stop — phase 4b) and confirmed the previewed diff. newStopOrder is the
  // full desired list of committed/locked stop IDs in order — a currently
  // committed stop left out is removed, a locked stop included is added.
  // acceptEndDateChange must be set when the previewed diff showed an
  // endDateChange (add/remove can change the trip's day count, unlike a
  // pure reorder) — otherwise the commit refuses to touch settings.endDate
  // as a side effect of an edit the traveler didn't ask to extend/shorten.
  reconcileCorridorContext: z
    .object({
      newStopOrder: z.array(z.string()),
      acceptEndDateChange: z.boolean().optional(),
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
export type EmptyCountry = z.infer<typeof emptyCountrySchema>
export type PlanMeta = z.infer<typeof planMetaSchema>
export type Trip = z.infer<typeof tripSchema>
export type DaySlot = z.infer<typeof daySlotSchema>
export type OvernightStop = z.infer<typeof overnightStopSchema>
export type DriveLeg = z.infer<typeof driveLegSchema>
export type TripDay = z.infer<typeof tripDaySchema>
export type CorridorStopStatus = z.infer<typeof corridorStopStatusSchema>
export type CorridorStopPriority = z.infer<typeof corridorStopPrioritySchema>
export type SightTimeNeeded = z.infer<typeof sightTimeNeededSchema>
export type CorridorStop = z.infer<typeof corridorStopSchema>
export type ReconcileDayChange = z.infer<typeof reconcileDayChangeSchema>
export type ActivityCategory = z.infer<typeof activityCategorySchema>
export type ItemStatus = z.infer<typeof itemStatusSchema>
export type ActivityTimeOfDay = z.infer<typeof activityTimeOfDaySchema>
export type Activity = z.infer<typeof activitySchema>
export type Meal = z.infer<typeof mealSchema>
export type Restaurant = z.infer<typeof restaurantSchema>
export type RoadFees = z.infer<typeof roadFeesSchema>
export type SpeedLimits = z.infer<typeof speedLimitsSchema>
export type LpgInfo = z.infer<typeof lpgInfoSchema>
export type CountryBriefSection = z.infer<typeof countryBriefSectionSchema>
export type CountryBrief = z.infer<typeof countryBriefSchema>
export type CountryGuideSection = z.infer<typeof countryGuideSectionSchema>
export type LogEntry = z.infer<typeof logEntrySchema>
export type SharedTripPlace = z.infer<typeof sharedTripPlaceSchema>
export type SharedTripDay = z.infer<typeof sharedTripDaySchema>
export type SharedTripStop = z.infer<typeof sharedTripStopSchema>
export type SharedTripDiaryEntry = z.infer<typeof sharedTripDiaryEntrySchema>
export type SharedTripView = z.infer<typeof sharedTripViewSchema>
export type PlanRequest = z.infer<typeof planRequestSchema>
