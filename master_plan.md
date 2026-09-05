# RV ROAD TRIP PLANNER — MASTER ARCHITECTURE & BUILD PLAN
**Version 1.0 — This is the source-of-truth document. Implementation models: read this fully before every work session. Tick off tasks in Section 9 as you complete them. Never skip a test gate.**

---

## 1. PRODUCT SUMMARY

A Progressive Web App (PWA) for planning and executing a European RV road trip.

- **Users:** A family sharing one trip plan across two phones + an iPad, in real time.
- **Engine:** Hybrid — Claude API does creative itinerary planning (route shape, pacing, hidden gems matched to the family's interests); Google Places API supplies live data (ratings, opening hours, photos, Google Maps navigation links).
- **Vehicle constraints baked in:** RV, 3,500 kg, registered as a car (affects speed limits, tolls, ferry pricing).
- **Core loop:** Input trip parameters → AI generates paced day-by-day plan → interactive map with zoom-based detail → daily execution view with activity log → automatic re-plan prompt when >50 km behind schedule.

### Locked decisions (do not revisit)
| Decision | Choice |
|---|---|
| Platform | PWA (React), installable on iOS/Android/iPad |
| Hosting | Firebase Hosting |
| Sync/DB | Cloud Firestore (real-time, offline-capable) |
| Auth | Firebase Auth (anonymous + trip share-code; upgradeable to Google sign-in) |
| Maps | Google Maps JavaScript API |
| Place data | Google Places API (New) |
| Routing | Google Routes API |
| AI planning | Claude API (`claude-sonnet-5` — switched from `claude-sonnet-4-6`; cheaper under intro pricing through 2026-08-31, same 1M context), called ONLY from Firebase Cloud Functions |
| Repo | GitHub, CI via GitHub Actions → Firebase deploy. Workload Identity Federation (keyless GCP auth, no service-account JSON key — blocked by org policy) authenticates every deploy. `.github/workflows/ci.yml` builds and tests (incl. E2E against the Firebase Emulator Suite) on **every** branch — deliberately un-filtered, see 2026-08-02's trunk entry in Section 11 — and deploys only from `main`. `.github/workflows/deploy.yml` is a second, **manual-dispatch** path for the same deploy, with a target picker (hosting / functions / rules / all): a release mid-trip is a decision someone makes, not a side effect of merging. Between them there is no case left that needs a `firebase deploy` from somebody's laptop, which is what releases actually depended on until 2026-08-10. |
| Cloud region | `europe-west1` for Firestore and all Cloud Functions (set via `setGlobalOptions` in `functions/src/index.ts`). Do NOT use `europe-north2` (Stockholm) — Cloud Functions triggers are not supported there, causes deploy failures. |

---

## 2. TECH STACK & PROJECT SETUP

- **Frontend:** React 18 + Vite + TypeScript
- **State:** Zustand (local UI state) + Firestore listeners (shared trip state)
- **Styling:** Tailwind CSS. Mobile-first, responsive breakpoints: `sm` phone, `md` large phone/small tablet, `lg` iPad landscape (split-pane layouts)
- **Maps:** `@vis.gl/react-google-maps`
- **PWA:** `vite-plugin-pwa` (service worker, manifest, install prompt, offline shell)
- **Backend:** Firebase Cloud Functions (Node 20, TypeScript) — hosts ALL secret keys (Claude API key, server-side Places calls). The browser NEVER holds the Claude key.
- **Testing:** Vitest (unit), Playwright (E2E), Firebase Emulator Suite (Firestore + Functions locally)

### Environment keys
| Key | Where it lives |
|---|---|
| Google Maps JS API key | Frontend `.env` (`VITE_GOOGLE_MAPS_API_KEY`, restricted by HTTP referrer in Google Cloud Console) |
| Google Places/Routes key | One Google Cloud API key (restricted to Places API (New) + Routes API), stored as **two** separate Cloud Functions secrets since the code reads them under different names: `firebase functions:secrets:set GOOGLE_PLACES_API_KEY` and `firebase functions:secrets:set GOOGLE_ROUTES_API_KEY` (same key value in both) |
| Claude API key | Cloud Functions secret (`firebase functions:secrets:set CLAUDE_API_KEY`) |

---

## 3. SYSTEM ARCHITECTURE

```
┌───────────────────────────────────────────────────────────────────┐
│  PWA (React + Vite)  — phone A / phone B / iPad                   │
│  ┌────────┐ ┌─────────┐ ┌──────────┐ ┌─────┐ ┌───────┐ ┌───────┐  │
│  │ Trip   │ │ Map tab │ │ Day View │ │Diary│ │Country│ │ Trip  │  │
│  │ Setup  │ │ (2 modes│ │          │ │     │ │ Guide │ │switch │  │
│  └───┬────┘ │  below) │ └────┬─────┘ └──┬──┘ └───┬───┘ └───┬───┘  │
│      └──────┴────┬────┴──────┴──────────┴────────┴─────────┘      │
│         Firestore SDK (real-time listeners, offline cache)        │
│         + httpsCallable for the on-demand operations              │
└──────────────────────────┬────────────────────────────────────────┘
                           │
        ┌──────────────────┴───────────────────┐
        │             FIREBASE                 │
        │  Firestore  ←→  Cloud Functions      │
        │  (trip data)    (europe-west1)       │
        └──────────────────┼───────────────────┘
            ┌──────────┬───┴────┬───────────┐
            ▼          ▼        ▼           ▼
        Claude API  Places   Routes    Overpass/OSM
        (planning)  (detail) (drive)   (stellplatz +
                                        free parking,
                                        corridor-wide)
```

**The Map tab has two modes**, chosen by `planMeta.status`:

- **Explore mode** (`status: 'idle'` — no plan yet). `ExploreMapScreen`: a
  cheap, repeatable curation pass. "Find great stops" / "Generate overview"
  runs *only* Claude's highlights phase and writes the results as
  `candidate` corridor stops. The traveler sets an interest level per stop,
  keeps or rejects them, drops pins, and rescans areas — all before paying
  for a single day of itinerary detail. The drawn route runs through the
  `locked` stops **only** (revised 2026-08-10 — it used to be `locked` +
  `must-see`, which gave two unrelated controls the same effect and let them
  disagree; interest is now triage, keeping is the commitment), and every
  other candidate's detour is measured against that route, so keeping a stop
  reshapes it and re-measures everything else.
- **Plan mode** (any other status). `OverviewMapScreen`: the generated
  day-by-day plan, its real driving route, and corridor editing.

**Two independent paths into the backend**, deliberately not merged:

1. **The `planRequests` queue** → `generatePlan` (a Firestore `onDocumentCreated`
   trigger) — every *expensive* write path: `full`, `replan`, `insertRestDay`,
   `reconcileCorridor`, `fromExploreCandidates`. Guarded by `planMeta.status`
   so only one runs per trip at a time.
2. **`httpsCallable` functions** — everything on-demand and comparatively
   cheap: `generateExploreHighlights`, `rescanCorridor`,
   `researchMoreAlternatives`, `getOvernightCandidates`,
   `refreshOvernightOptions`, `previewReconcileCorridor` (a pure dry run),
   `researchCountrySections`, plus trip lifecycle (`createTrip`, `joinTrip`,
   `deleteTrip`, `mergeTrips`), read-only sharing (`createTripShareLink`,
   `revokeTripShareLink`, `viewSharedTrip`) and `claimAccess`.

   `refreshOvernightOptions` is a callable rather than a `planRequests` kind
   for a specific structural reason, not just cost: it reads only each day's
   town and writes only that day's overnight options plus its committed
   overnight point. Drive legs are measured town-to-town, so nothing it does
   invalidates a distance already computed — which means it needs no plan
   lock and can run on a trip that is `ready`, mid-edit, or anything else.

   Explore mode's generation is a callable *on purpose*: routing it through
   `planRequests` would flip the trip out of `idle` and collapse the Map tab
   back to plan mode mid-curation. It has its own `planMeta.exploreStatus`
   guard instead.

**Data flow for a full generation:**
1. Client writes a `planRequests` doc (`status: 'pending'`).
2. `generatePlan` triggers; a transaction claims `planMeta.status`, rejecting
   any competing request. The claim carries a heartbeat and expires
   (`planLock.ts`) so a crashed run can't wedge the trip forever.
3. Claude runs in three sequential phases (Section 6.1): highlights →
   route outline → per-chunk day detail. Phase 1 is skipped and seeded from
   the traveler's curated corridor stops whenever the trip has any — for
   *both* generate buttons since 2026-08-12, not just the explore-mode
   commit.
4. Each day is enriched: Routes API for real drive legs, Places API for
   activities/restaurants. Days are **staged to `generationStaging` as they
   resolve**, so a failure resumes rather than restarting.
5. If the invocation nears its time budget, it writes itself a continuation
   request (`isContinuation`) and hands off — a long trip spans several
   invocations rather than dying at the 540s ceiling.
6. Days are committed and `corridorStops` re-materialized — the *committed*
   ones only; candidates, rescan finds and hand-dropped pins survive a
   generation (2026-08-12).
7. One overnight-options pass runs over the written days (Section 4's
   `overnightOptions` subcollection): campsites from Places, stellplatz and
   free motorhome parking from a handful of corridor-wide Overpass queries
   for the whole trip, then each day's committed overnight is moved onto the
   best of them. Best-effort — a failure here leaves every day on its town
   point, which is worse than having sites but far better than no plan.
8. Checkpoint cleared, pacing advisories written, `status: 'ready'`. All
   devices update live via Firestore listeners.

**Authorization.** Callables run on the Admin SDK, which bypasses
`firestore.rules` entirely — so every `tripId`-taking callable must call
`requireTripMember` (`functions/src/authz.ts`) itself. Rules still govern all
direct client reads/writes.

**Why this shape:** API keys stay server-side; heavy work is off-device; two
phones stay in sync for free via Firestore listeners; offline reads work from
Firestore's local cache.

---

## 4. DATA MODEL (Firestore)

```
trips/{tripId}
  meta:        { name, shareCode, createdAt, version }
  settings:    { startDate, endDate,
                 startPoint: {name, lat, lng},
                 endPoint:   {name, lat, lng},
                 travelers:  [{name, role: adult|child, age?}],
                 interests:  [string],           // e.g. castles, hiking, beaches
                 preferredCountries: [ISO codes],
                 restDayFrequency: number,        // days between rest days, default 7
                 maxDriveHoursPerDay: number,     // default 4
                 offGridTolerance?: number,       // free nights in a row before the
                                                  // plan has to service the RV;
                                                  // default 3, 0 = never free.
                                                  // Optional: pre-existing trips
                                                  // have none stored (read it via
                                                  // offGridToleranceOf()).
                 vehicle: { type:"RV", weightKg:3500, registeredAs:"car",
                            heightM?, lengthM?, widthM?, fuel?: diesel|petrol|electric|lpg } }
                 // dimensions + fuel feed the countryGuide prompt: bridge/ferry
                 // tolls are frequently tiered by length/height, clearance
                 // warnings need height+width, and some tolls/ferries discount
                 // by fuel type (T-18/T-27's road fees + driving rules sections).
  notes:       { freeText: string, updatedAt }    // THE editable "text file".
                                                  // Injected into EVERY Claude call.
  planMeta:    { status: idle|pending|generating|ready|error|stale,
                 avgDriveMinutesPerDay, totalKm, generatedAt, lastReplanAt, error?,
                 // progress, surfaced live while generating
                 progressLabel?, progressCurrent?, progressTotal?,
                 // advisory pacing notes (Section 5) — at most one, written
                 // by pacingValidator.pacingWarnings(). Absent, not [], when
                 // there's nothing to say. Never fails a generation.
                 pacingWarnings?: string[],
                 // resumable generation (planCheckpoint.ts) — internal, never rendered
                 checkpoint?: { settingsHash, skeleton },
                 // busy-guard heartbeat; lets an abandoned claim expire (planLock.ts)
                 statusUpdatedAt?,
                 // explore mode's OWN guard — deliberately separate from `status`,
                 // so curating never flips the Map tab out of explore mode
                 exploreStatus?: idle|generating,
                 exploreStatusUpdatedAt?,
                 exploreLastRunAt? }              // distinguishes "never searched"
                                                  // from "searched, found nothing"

trips/{tripId}/members/{uid}            // membership; written only by Cloud Functions
  { joinedAt }

trips/{tripId}/days/{dayId}             // dayId is a Firestore AUTO-ID.
                                        // (Was the date; changed in phase 2a so a
                                        // day can be re-dated without being
                                        // deleted and recreated.)
  { index, date, type: drive|rest,
    overnight: {name, lat, lng, country, campsiteSuggestion,
                type?: campsite|stellplatz|wild,  // what the night is committed to
                freeCampingRule?: string},        // on a 'wild' night only: the
                                                  // country's own researched rule
                                                  // that permitted it
                                        // a REAL place since 2026-08-12 —
                                        // the campsite/stellplatz/free spot
                                        // picked from overnightOptions below,
                                        // not the geocode of the town's name
                                        // (which put "Berlin, Berlin, DE" at
                                        // an intersection in Mitte).
    townAnchor?: {lat, lng},            // where the day's TOWN is, as opposed
                                        // to where it sleeps — the two
                                        // separated once the overnight moved
                                        // onto a site up to 20 km outside it.
                                        // Kept so re-resolving options
                                        // searches around the town again
                                        // instead of around the last site
                                        // picked, which would drift a little
                                        // further out on every re-run. Absent
                                        // on days written before it existed,
                                        // where the overnight IS the town.
    drive: { fromName, toName, distanceKm, durationMin,
             slot: morning|midday|evening, polyline },
                                        // measured town-to-town, which is
                                        // what makes the overnight pass
                                        // re-runnable without invalidating
                                        // any distance already computed.
    summary: string,                    // Claude's 1-2 sentence day pitch
    highlightReason?: string,           // why this stop is on the route
    extraTimeReason?: string }          // why this place got more time

trips/{tripId}/days/{dayId}/overnightOptions/{autoId}   // where this night
  { name, type: campsite|stellplatz|wild,               // COULD be spent
    lat, lng, country, description,
    source: places|osm|claude, googleMapsUrl? }
  // Resolved for every day at generation and stored (2026-08-12), not looked
  // up on demand when "Change overnight" is opened. The on-demand version
  // cost, per day, an Overpass request and one or two Claude web-search
  // calls — which over sixty days is not a cost question but an
  // impossibility: a single one of those calls already took the picker past
  // its 180-second ceiling. Campsites come from Places (already being called
  // to place the overnight itself, so they're free); stellplatz and free
  // motorhome parking come from OSM in corridor-wide Overpass queries —
  // three requests for a 60-day trip rather than sixty. No Claude call at
  // all. The picker still falls back to `getOvernightCandidates` for a day
  // with nothing stored (a trip generated before this existed, or a day
  // added since).

trips/{tripId}/days/{dayId}/activities/{autoId}
  { name, category: sight|hike|museum|beach|playground|other,
    lat, lng, placeId?, rating, ratingCount, googleMapsUrl, photoUrl,
    openingHours?, blurb,               // Claude's hidden-gem pitch
    kidFriendly: boolean,
    timeOfDay?: morning|afternoon|evening,
    reserve?: boolean,                  // held back to refill the row on a skip
    status: suggested|selected|done|skipped,
    doneAt?, diaryNote? }

trips/{tripId}/days/{dayId}/restaurants/{autoId}
  { name, meal: breakfast|lunch|dinner, lat, lng, placeId?, rating, ratingCount,
    googleMapsUrl, priceLevel, cuisine, blurb, reserve?,
    status: suggested|selected|done, doneAt?, diaryNote? }

trips/{tripId}/corridorStops/{stopId}   // the route's stops as first-class objects
  { name, lat, lng, country?, why?,
    status: candidate|proposed|committed|locked,
    //  candidate  — explore mode's curated shortlist
    //  proposed   — a rescan find awaiting review, post-generation
    //  committed  — materialized from the generated days
    //  locked     — the traveler explicitly wants this one
    linkedDayIds: [dayId],              // committed stops only
    priority?: must-see|worth-a-detour|nice-if-convenient,  // explore mode only
    region?, rank? }                    // explore mode only: grouping + ordering

countryGuideSections/{docId}            // country research — NOT under a trip, so
  { countryCode, sectionId, title,      // one lookup serves every trip that needs it
    items: string[],                    // the findings, one per bullet
    sources: string[], generatedAt }
  // docId = `${countryCode}_${sectionId}_${vehicleKey|'any'}_${briefHash}`
  // (shared/src/countryBrief.ts). Everything that could change the answer is
  // in the key, so a hit is always safe to reuse: 'any' for sections whose
  // answer doesn't depend on the RV (camping, LPG), the vehicle's own key for
  // the ones that do (clearances, weight-banded limits, length-banded ferry
  // tiers), and the brief's hash so an edited question never serves the old
  // question's answer — nor overwrites the entry other travelers share.
  // Client-readable by any signed-in user, client-writable by nobody.

trips/{tripId}/log/{entryId}            // trip diary, derived from "done" items
  { date, refType: activity|restaurant, refPath, note?, createdAt }

trips/{tripId}/generationStaging/{index}  // internal: days already resolved by an
  { day, activities, restaurants }        // in-flight generation, so a retry or a
                                          // chained continuation resumes instead
                                          // of redoing the whole pipeline

users/{uid}/preferences/countryBrief    // the research brief: what to look up for
  { sections: [{ id, title, brief,      // EVERY country. Per traveler, not per trip
                 dependsOnVehicle }],   // (defaults in shared/src/countryBrief.ts)
    updatedAt }

users/{uid}/trips/{tripId}              // reverse index powering "My trips"
  { joinedAt }                          // (membership itself isn't queryable across trips)

shareCodes/{code}                       // code -> tripId lookup; server-only
  { tripId }

planRequests/{requestId}                // write-only queue for generatePlan
  { tripId,
    kind: full|replan|insertRestDay|reconcileCorridor|fromExploreCandidates,
    replanContext?, insertRestDayContext?, reconcileCorridorContext?,
    isContinuation?,                    // this request was chained by a prior
                                        // invocation that ran out of time budget
    status, error? }
```

**Sharing model:** a trip is joined by entering its 6-character `shareCode`.
Security rules: only UIDs listed in `trips/{tripId}/members/{uid}` can
read/write, and `planRequests` may only be created for a trip you belong to.
Joining via code goes through a Cloud Function so the code can be validated
server-side. Note that Cloud Functions run on the Admin SDK and therefore
bypass these rules entirely — see `requireTripMember` in Section 3.

**Editability:** every settings field and the notes doc are editable at any
time from the Settings screen. Editing a trip that already has a plan sets
`planMeta.status = "stale"` and the UI offers "Re-plan trip" — plans never
regenerate silently. Editing an `idle` trip leaves it `idle` (there's no plan
to invalidate).

---

## 5. PACING ALGORITHM (the "no monster last day" rule)

**Revised twice.** v1.0 (kept at the bottom) hard-failed the *entire* generated plan whenever any day exceeded 1.4× the trip's own computed average distance — an internal artifact of that specific route, not a constraint the traveler actually asked for. In production this rejected legitimate plans (e.g. a day that needed extra driving to reach a worthwhile stop) with no way to accept the tradeoff, and raising `maxDriveHoursPerDay` in Settings did nothing because that field was never checked at all. That revision dropped the trip-average gate and kept only what the traveler had actually asked for — which was right, and left the app with nothing at all to say about how a trip's driving was *distributed*. A Helsingborg→Berlin plan that spent two of its three days 45 km from the start passed every check it had.

**Current design** (`functions/src/pacingValidator.ts`), in three layers, only one of which can fail a generation:

1. **Generation guidance** (Section 6.1's outline prompt, `PACING_RULES` in `functions/src/prompts/planTripPrompt.ts`) — the 1.4×/1.0×-of-target shape below, plus rule 6, which states the back-loading problem in the terms the model can act on: short days and long stays are welcome and no day owes anybody a distance, but before committing to a stretch that covers little ground, work out what the remaining drive days would then have to average. A soft aim, not a post-hoc gate.

2. **Hard validation** — the only thing that fails a plan (`validatePacing`):
   - No day's actual resolved drive duration may exceed **1.5 × the traveler's own `maxDriveHoursPerDay`** (some tolerance for traffic/rounding) — this is the one real constraint the user set, so it's the one that's enforced.
   - Rest days must stay at the previous day's overnight (a genuine structural bug if violated, not a pacing tradeoff).
   - On failure the generation fails with a clear error (never show a bad plan).

3. **Advisory back-loading warning** (`pacingWarnings`, added 2026-08-12) — not a gate, and deliberately **not** a per-day minimum distance (see the superseded attempt below). The measure is the trip's own remaining budget: after each day, how much distance is left against how many drive days are left, compared with what the trip needed to average from the outset. That ratio starts at exactly 1.0 by construction and climbs only when days come in under average, which makes it a direct read on back-loading and completely indifferent to how any individual day is spent — a slow first week balanced by a slow rest of the trip never trips it; a slow first week followed by a forced march does. Thresholds: the required pace must exceed **1.4×** the trip's average (mirroring rule 3's own per-day ceiling — a trip that has to *sustain* what that rule allows as an occasional maximum is one that spent something earlier it could not afford), with at least **3 drive days remaining** (one long final day is a long final day, already bounded by layer 2), on a trip of at least **4 drive days** (below that there is no distribution to speak of, and no ratio can tell "wasteful" apart from "that is why we came"). **One warning per trip, at the worst point** — the shape is a single fact about the trip, and listing every day that contributed to it would bury it. Written to `planMeta.pacingWarnings` by `generatePlan`, `replanTrip` and `corridorReconciliation` alike, and shown as a dismissible banner on the overview (Section 7.2). Dismissal is keyed on the warning text, so a regeneration with something new to say gets to say it.

4. Every day's `highlightReason` (see 6.1) is persisted and shown in the Day View, so a day that's longer than the trip's own average is *explained*, not silently rejected or silently allowed with no context.

**Not verified against a real plan.** The warning has never fired on a genuinely generated trip — only on crafted fixtures in `pacingValidator.test.ts`. Whether 1.4× is the right line, and whether the sentence it produces reads as advice rather than a scolding, are open questions until it fires on a real one.

<details>
<summary>The per-day minimum (superseded the same day it landed, 2026-08-12)</summary>

The first attempt flagged any drive day covering less than half the trip's average distance. The trip owner rejected it outright: on a two-month trip short days and long stays are the *point*, so a rule that treats a 40 km day as a defect is wrong about the product, and gets more wrong the longer the trip. What had actually gone wrong on the trip that prompted the work was not that a day was short. It was that the shortness was never paid for until the end, and then all at once — which is a fact about the whole trip, not about any day in it. Replaced by the back-loading measure above, which asks that question directly and has no opinion at all about how any single day is spent.

Two leftovers from this attempt are still in the source and read as if it were live: `planMetaSchema.pacingWarnings`' comment in `shared/src/schemas.ts` and the banner comment in `OverviewMapScreen.tsx` both describe "drive days that barely move the trip along". The behaviour is the back-loading one; the comments are stale.

</details>

<details>
<summary>Original v1.0 design (superseded, kept for history)</summary>

1. Compute total route distance (Routes API, start → mandatory waypoints → end).
2. Available drive days = total days − rest days (1 per `restDayFrequency`) − extra-time days Claude assigns to standout places.
3. Target daily drive = totalKm / driveDays. Hard caps: no day > 1.4 × target, and **the final 2 days must each be ≤ 1.0 × target** (guarantees a relaxed finish).
4. Code-side validator checks every generated plan against rule 3. If violated → automatic one-shot retry with violation fed back to Claude → if still violated, mark plan `error` with details (never show a bad plan).
5. Rest days are placed in high-interest locations, never in transit towns.

</details>

---

## 6. CLAUDE PROMPT CONTRACTS (Cloud Functions)

Three prompt templates live in `functions/src/prompts/`. All must demand **JSON-only output** matching a zod schema; parse with `JSON.parse` after stripping code fences; on schema failure retry once with the error appended.

### 6.1 `planTrip` — **revised: now three sequential Claude calls, not one**

**Original design (superseded):** a single Claude call did curation, route-scheduling, and day-by-day detail all at once. Two problems this caused in production: (a) a single call covering a long/multi-week trip could exceed the Anthropic SDK's ~10-minute non-streaming guard, and (b) doing curation and scheduling in the same pass biased route selection toward whatever town was geographically closest to the direct line — interests only ever influenced which *activities* got picked in towns already locked in, never *which towns* the route passed through. So "plan the best route for our interests" wasn't actually implemented, even though interests were an input.

**Current design** (`functions/src/prompts/planTrip.ts`, `planTripPrompt.ts`, `planTripSchema.ts`):

1. **Highlights phase** (`buildRegionHighlightsPrompt`) — pure curation, no dates/pacing involved. Given `settings` + `notes.freeText`, Claude reasons region-by-region about what's genuinely worth seeing for these travelers' interests and returns a ranked shortlist per region of **candidate overnight towns**: `must-see` / `worth-a-detour` / `nice-if-convenient`, each with a 2–4 sentence "why" written to be decidable on without looking the town up elsewhere. Deliberately generous — more candidates than any one trip could fit. An empty `regions` (or an empty `candidateStops` within one) is explicitly sanctioned as an honest answer for a short or local trip, rather than something to pad around. **Skipped entirely whenever the trip already has curated corridor stops** — for both generate buttons since 2026-08-12, not just the explore-mode commit; see 11's entry for why the two used to differ. (This phase is the subject of the in-flight "sights lead the route" change — see Section 11.)
2. **Outline phase** (`buildRouteOutlinePrompt`) — given the highlights shortlist, *selects* from it (prioritizing must-sees) and sequences the selections into an actual day-by-day route from the real `startPoint` to the real `endPoint`, balancing attraction quality against time remaining and overall heading. Free to skip lower-priority candidates or add a plain connecting overnight where two highlights are too far apart for one day's drive. Every day gets a required `highlightReason` (why this town, tied to interests/notes — forces justification instead of defaulting to "closest on the way"). This is where pacing/global-routing correctness is solved, with the whole trip in view, same as the old single call.
3. **Detail phase** (`buildChunkDetailPrompt`, chunked) — the route is split into fixed-size chunks (7 days each); each chunk gets a separate call, given the full outline for context but only asked to fill in that chunk's 5 activities + 9 restaurants (NAME + TOWN + CATEGORY only — Places API resolves details/ratings/links afterwards, Claude must not invent them) and a day `summary` + optional `extraTimeReason`. Cannot redirect the route the outline already committed to.

Every individual call stays small regardless of trip length — this is what actually fixed the 10-minute-guard problem, not just raising `max_tokens`. `onProgress` callbacks report which phase is running (`{phase: 'highlights'}` / `{phase: 'outline'}` / `{phase: 'detail', chunkIndex, chunkCount}`) so the UI can show real progress instead of a bare "generating" spinner.

All three calls: JSON-only output, zod-validated, one retry on parse/schema failure with the error fed back to Claude, and (since 2026-07-30) one retry on a transient *API-level* failure too — the `messages.create` call itself sits inside the retry's `try`, which it originally did not.

**Salvage, highlights only** (`salvageJsonPrefix`/`salvageRegionHighlights`, 2026-08-12). A curation response that fails to parse is cut back to the longest prefix that *is* valid JSON, closing whatever containers are still open at that point, and re-validated against the real schema. Root cause: a production failure on trip "Luxemburg" where 5,609 characters of complete curation were discarded because the last candidate ended `"why "` with no value — `JSON.parse` is all-or-nothing, both attempts failed the same way, and the callable 500'd after paying for two Claude calls. The usage log showed 4 of 12 highlights runs needing their retry, so both attempts missing is simply the tail of a rate the code already lived with. The scan tracks string/escape state, so a brace inside a `why` sentence is never mistaken for structure, and it only ever truncates at a boundary the model itself closed — nothing is invented.

**Deliberately scoped to the highlights call.** A shortened candidate list is a valid answer (the schema allows any number of regions and candidates), so the worst case costs the traveler the last town. The outline and detail calls get no salvage: a truncated route outline would silently shorten a trip, and a truncated day chunk would leave a day empty. Those still fail loudly.

Generation as a whole *is* resumable — the skeleton and each resolved day are checkpointed (`planCheckpoint.ts`), and a run that nears its time budget chains a continuation rather than dying at the 540 s ceiling. See Section 11's "Resumable / checkpointed plan generation" and "Segmented/chained plan generation" entries. (The rolling-detail-window direction in Section 11 would make most of that machinery redundant, since the phase it exists to survive leaves generation.)

### 6.2 `replanTrip` — extra inputs, and a real fix (2026-07-27)

**Bug, now fixed:** `runReplan` (`functions/src/replanTrip.ts`) never actually called `planTrip()` — it was a hard-coded fixture that produced at most two days (one drive straight from the current location to the trip's final destination, plus an optional rest day), regardless of how many days actually remained. Any "Request changes" replan therefore replaced the entire remainder of a trip with essentially just the final stop — reported live as "all stops but final stop removed." This was a known, documented gap (T-17's own notes below called it a stand-in for T-14) that was never closed after `generatePlan.ts` got the real pipeline.

**Current design:** `runReplan` now runs the same real pipeline as a fresh generation — `planTrip()` (Section 6.1's three phases) + `resolveSkeletonDays` (Places/Routes enrichment) — shared via `functions/src/planPipeline.ts` (extracted specifically to avoid a circular import between `generatePlan.ts` and `replanTrip.ts`, which import from each other). Inputs: current GPS location (as the remainder's `startPoint`), today's date (`startDate`) through the remaining end date (`endDate`), the remaining end point, and — newly wired up, previously collected but never actually used — the change-request free text, folded into the notes Claude sees. Two correctness properties the old fixture's simplicity had accidentally never needed:
- **Generate before delete.** The new remainder is fully generated, resolved, and pacing-validated *before* any existing future day is touched — a failed replan (API error, pacing violation) now leaves the trip's existing days fully intact instead of chopped with nothing to replace them.
- **Locked-day collision safety net.** A locked day can sit anywhere in the remainder's date range (the "Request changes" UI allows locking any day, not just the boundary), but `planTrip()` has no way to be told "skip this date" — so any generated day that would land on an already-locked date is dropped before writing rather than allowed to overwrite it. Known limitation: the route itself isn't planned *around* a mid-range locked day's location (Claude doesn't know it exists), only protected from being overwritten — genuinely reasoning about mid-route locked waypoints is future work if it turns out to matter in practice.

### 6.3 `countryGuide` prompt — inputs
- One section at a time (`functions/src/prompts/countrySection.ts`): the country, the vehicle, and **that section's own brief text**, which is the instruction. Output is the same flat `{ items, sources }` shape whatever the section asks, so a traveler-written section needs no code change. Enable Claude web search in this call so fees/vignette prices are current; require source-cautious phrasing ("as of {date}").

### 6.4 Places enrichment (code, not Claude)
For each Claude-proposed name+town: Places Text Search → take the top match that is within 30 km of the day's anchor **and whose name actually looks like the one asked for** → fetch rating, ratingCount, googleMapsUri, photo, opening hours, priceLevel. If no match ≥3.8 rating with ≥50 reviews, drop it and backfill from Places Nearby Search by category so the counts (5 activities, 3×3 restaurants) always hold.

Both of those filters are enforced rather than merely requested (2026-08-10). Places' `locationBias` is a preference, not a bound — with nothing matching nearby it will answer with the best match on another continent, which is how a dinner stop for a night in Helsingør became a hotel in Greece. Distance alone doesn't catch the other failure either: a famous landmark well *inside* the radius answering for a small café in the same town. `nameLooksRight` compares diacritic-folded, stopword-stripped tokens (dropping "restaurant", "hotel", "museum" and friends, which would otherwise match anything of that kind), so a fuller or shorter listing name for the same place is accepted and an unrelated one sharing only the town is not.

**Gotcha (fixed):** the Places API (New) rejects `point_of_interest` as an `includedTypes` value for `searchNearby` — it's a Text-Search-only generic type. The `other` activity category used to map to it, so any "other"-category activity that missed the quality bar on text search and fell back to nearby search 400'd and failed the *whole* plan generation. Fixed by omitting the type filter entirely for that category instead of sending an invalid one (`functions/src/placesApi.ts`).

---

## 7. SCREENS & UI CONTRACTS

### 7.1 Trip Setup / Settings
- Form: dates (range picker), travelers (add rows: name, adult/child, age), interests (chip multi-select + free entry), start & finish (Places autocomplete), preferred countries, rest-day frequency (slider: "rest day every N days", default 7, option "none"), max drive hours/day.
- **Preferred countries** is sixteen quick-pick chips (the ones this app's trips actually cross) **plus a search box over the full ISO 3166-1 set** (2026-08-13). Until then the chips were the only countries choosable at all, so a trip to Luxembourg — reported with a screenshot of a trip literally named "Luxemburg" — had no way to name its own destination. Picking a search result appends a chip that looks and deselects exactly like the presets. Deliberately a *closed* vocabulary rather than the free-text entry the interests chips use: `tripSettingsSchema` requires two-letter codes, and a rejected settings write doesn't fail loudly on the client — it fails on the next read of the trip document, i.e. the trip stops working. Only the alpha-2 code is ever stored, so nothing downstream can tell a searched country from a preset one.
- **Notes panel:** full-screen editable text area bound to `notes.freeText`, autosaved, with "last updated" stamp. Placeholder explains: "Anything here is read by the planner on every generation — allergies, must-sees, driving preferences…"
- Buttons: **Generate overview** (cheap — runs only Claude's highlights phase and lands you in explore mode on the Map tab) and **Generate full plan** / **Re-plan** (the expensive day-by-day generation, behind a confirmation dialog). Both refuse to spend a call until a start AND finish point are genuinely **located** — a name alone isn't enough, since a blank (or typed-but-unresolved) point still reads as a valid `(0,0)` coordinate downstream, so it has to be caught here.
- **Refresh overnight stops** (shown for a `ready`/`stale` trip): re-runs the whole trip's overnight-options pass through the `refreshOvernightOptions` callable and reports how many days it touched. Cheap enough to press repeatedly — no Claude call, a handful of Overpass requests however long the trip is — and structurally safe to re-run, because it reads only each day's `townAnchor` and writes only that day's options and committed overnight. This is what makes iterating on where to sleep possible at all on a two-month trip: the alternative was regenerating sixty days, paying for the entire Claude pipeline again, to change something Claude was never consulted about.

### 7.2 Map tab
The Map tab renders one of two screens depending on `planMeta.status`.

**Explore mode (`idle` — no plan yet).** `ExploreMapScreen`: map on top,
candidate list below **in route order** (2026-08-12).
- "Find great stops" runs the highlights-only curation pass; results appear
  as `candidate` corridor stops.
- **The list is sorted along the corridor** (`sortAlongRoute`, `shared/src/geo.ts`)
  rather than grouped into three priority tiers. The tiered grouping answered
  "which of these does the app think are best", which the card already says,
  and made the question the traveler actually had — where does this sit
  relative to the others, is it before or after Hamburg — one they had to
  reconstruct by cross-referencing three lists against the map.
- **Interest is a control on the card**, not a place in the list: a
  three-way selector (Must see / Worth a detour / If convenient) writing
  `priority` directly. It replaced up/down arrows, which had made sense while
  the list *was* sorted by tier — the arrows were how you moved a card
  between headings — but in route order a vote no longer moves the card at
  all, only repaints it, and an arrow that changes a value you cannot see is
  a worse control than a switch showing it. `rank` is no longer written:
  it only ever ordered stops within a tier, and nothing reads that order.
- Each card can also be kept (`locked`) or rejected. Tapping a map pin
  scrolls its card into view.
- **The drawn route runs through the `locked` stops only** (2026-08-10).
  Ranking a stop must-see used to add it to the backbone too, which gave two
  unrelated controls the same effect, let them disagree, and left a must-see
  stop wearing the route's blue ring with no "Keeping" chip and a "Keep this"
  button that changed nothing visible. Interest is triage; keeping is the
  commitment. Every other candidate's detour — distance and time, from the
  same straight-line estimate — is measured against that route, so keeping a
  stop reshapes it and re-measures everything else. Stops on the route show
  "On route" rather than a detour figure.
- "+ Add stop" (pick a place, or describe what you want in free text) and
  "Rescan this area" both anchor to wherever the map is currently looking.
- "Generate full plan (N stops)" commits the curation into the real
  generation, behind a confirmation dialog.

**Plan mode (any other status).** `OverviewMapScreen`:
- Full-screen Google Map with the route polyline and overnight-stop markers.
- **Zoom-based progressive disclosure:**
  - z < 6: route + start/end + country flags
  - 6–8: + overnight stops (numbered day badges)
  - 9–11: + selected activities
  - ≥ 12: + ALL suggested activities & restaurants with category icons (fork = food, mountain = hike, castle = sight, wave = beach, balloon = kids, bed = overnight)
- Header bar: total km, **average driving time per day**, days count.
- **Pacing advisory banner** (Section 5, layer 3) when `planMeta.pacingWarnings`
  is non-empty: amber, dismissible, keyed on the warning text so a
  regeneration with something different to say can say it. Advice, not a
  gate — the plan below it is valid and usable either way.
- Tapping a route segment or day badge → Day View for that day.
- "Request changes" button → change interface: free-text box ("more beaches, skip big cities") + per-day lock toggles → submits a `replan` request with that text appended to notes context.

### 7.3 Day View
- Layout: **map on top (~45% height), scrollable content below** (user-specified). iPad `lg`: side-by-side split.
- Map shows that day's drive polyline, overnight stop, and pins for the items currently in view below (tapping a card highlights/pans to its pin — user-specified).
- Below: day summary + drive card (from → to, km, duration, suggested slot morning/midday/evening) then horizontally scrollable card rows: Activities (5), Breakfast (3), Lunch (3), Dinner (3).
- Each card: photo, name, category, Google rating ★ + count, blurb, "Navigate" (opens `googleMapsUrl`), and a check control: mark **Selected** (planned) or **Done** (logged to diary with optional note).
- Prev/Next day arrows + swipe to cycle days without returning to overview (user-specified).
- Rest days render with a "No driving today 🎉" banner.
- **"Change overnight"** opens the day's stored `overnightOptions` — a plain Firestore read of something already resolved at generation, not a live multi-source lookup while someone watches a spinner (which is what used to sit here, and what used to time out). Falls back to the `getOvernightCandidates` callable only for a day with nothing stored. Picking one submits a scoped replan (locking every prior day) rather than a client-side write, since moving a night ripples into the following drive leg.

### 7.4 Execution mode & 50 km rule
- Active automatically when today ∈ [startDate, endDate].
- On app open + every 30 min while open: get device GPS → compute distance to today's planned overnight route position → if **> 50 km behind**, show a non-blocking prompt: "You're {X} km behind plan. Re-plan the rest of the trip?" [Re-plan] [Snooze today].
- Uses `navigator.geolocation`; degrade gracefully if permission denied (manual "I'm here" pin instead).

### 7.5 Country Guide
- Tab listing each country on the route with flag; detail page renders the six info sections as accordions. Generated once per country at plan time (Cloud Function), cached in Firestore, "Refresh info" button re-generates.

### 7.6 Diary / Log
- Chronological list built from `log/` — everything marked Done, with notes and dates. Simple export to text/share sheet.

### 7.7 Trip management & account backup
- **Trip switcher** in the header ("My trips (N)"): switch between trips, start a new one (inherits the previous trip's settings and notes, but NOT its start/finish points), or delete one. Backed by the `users/{uid}/trips` reverse index, since membership alone isn't queryable across trips.
- **Share menu:** copy a join link, or enter a 6-character code to join someone else's trip.
- **Account backup:** optional Google account linking, so a trip survives losing the device. Linking a Google account already tied to another Firebase user merges that account's trips across (`mergeTrips`); the proof needed to complete that merge is persisted before the identity switch so a failure mid-flight can be retried rather than orphaning trips.

---

## 8. NON-FUNCTIONAL REQUIREMENTS

- **Responsive:** test at 375×812 (phone), 820×1180 (iPad portrait), 1180×820 (iPad landscape). No horizontal scroll, tap targets ≥ 44 px.
- **Offline:** app shell + last-synced trip data readable offline (Firestore persistence + PWA cache). Map tiles require network — show cached day cards with an offline banner.
- **Multi-device:** edits on one device visible on another < 3 s (Firestore listeners; verify in E2E).
- **Cost guards:** plan generation debounced (one pending request per trip); Places photos requested at 400 px; country guides cached.
- **Privacy:** GPS never leaves the device except inside replan requests (rounded to 3 decimals).

---

## 8a. DEBUGGING AGAINST THE REAL APIS

Every model-facing behaviour in this app is decided by a prompt plus two
third-party lookups, and for a long time the only way to see what any of it
actually did was to run the deployed app from a phone, against the traveler's
own trip. That is why the downhill-biking miss (2026-08-15) was diagnosed by
reading the prompt and reasoning about what it must have done: the two
hypotheses that mattered — the bike parks were never proposed, versus they
were proposed and Places verification threw them away — produce identical
symptoms on screen and have completely different fixes.

`npm run debug:curate` answers that question directly. It calls
`generateRegionHighlights` with the same prompt, model and Places
verification production uses, and prints every candidate with whether it
located. No Firestore, no trip, no emulator, nothing written anywhere.

```
cp .env.debug.local.example .env.debug.local     # then fill in the two keys
npm run debug:curate -- --to "Sundsvall, Sweden" \
  --interests "downhill mountain biking" \
  --notes "we want lift-served downhill riding"
```

A `📍` candidate was proposed and found; a `❌` was proposed and rejected by
verification, with the reason logged above the report; a place that appears
in neither list was never proposed at all, which points at the prompt rather
than at Places.

It reads `CLAUDE_API_KEY` and `GOOGLE_PLACES_API_KEY` through the same
`defineSecret(...).value()` the deployed functions use — which falls back to
`process.env` outside a deployed runtime — so there is no test-only branch
anywhere in the pipeline it exercises. Both keys already exist in Google
Secret Manager for the deployed functions.

`npm run debug:search` does the same for "Rescan this area", and exists for
a sharper reason: three consecutive rescan failures were each reported as the
same sentence on a phone with the actual cause never leaving the server —
firebase-functions forwards only an `HttpsError`'s message, so everything
else arrived as the bare code `internal`. Both callables now say what broke
(`describeCause`), but a message on a phone is still a slow way to ask; this
prints the exception itself, and the wall time with it, which is the
measurement that separates "too slow" from "broken".

```
npm run debug:search -- --lat 56.51 --lng 13.04 --radius 25
npm run debug:search -- --lat 56.51 --lng 13.04 --query "downhill bike park"
```

Both cost real money: a Claude call each, plus Places lookups per result —
and for the search, up to three web searches inside the turn. Cents per run,
but not something to loop.

---

## 9. SEQUENTIAL TASK LIST WITH TEST GATES

**Rules for implementation models:**
1. Do tasks strictly in order. 2. A task is done only when its ✅ TEST passes. 3. Tick the checkbox and commit (`git commit -m "T-XX: …"`) after each task. 4. If a test fails twice, stop and write findings under the task before continuing. 5. Re-read Sections 4–7 before any task that touches data or UI.

### PHASE 0 — Foundation
- [x] **T-01** Create GitHub repo `rv-trip-planner`; scaffold Vite + React + TS + Tailwind; add ESLint/Prettier.
  ✅ TEST: `npm run dev` serves the starter page; `npm run lint` passes.
- [x] **T-02** Create Firebase project; enable Firestore, Auth (anonymous), Functions, Hosting; install Emulator Suite; commit `firebase.json`, `.firebaserc`.
  ✅ TEST: `firebase emulators:start` runs Firestore + Functions locally.
- [x] **T-03** GitHub Actions: on push to `main` → lint, unit tests, build, deploy to Firebase Hosting preview channel.
  ✅ TEST: pipeline green on a dummy commit; preview URL loads.
- [x] **T-04** PWA setup: manifest (name, icons, standalone), service worker via vite-plugin-pwa, offline app shell.
  ✅ TEST: Lighthouse PWA check passes; app installable on a phone; loads shell offline.
- [ ] **T-05** Google Cloud: enable Maps JS, Places (New), Routes APIs; create browser key (referrer-restricted) + server key; store server key & `CLAUDE_API_KEY` as Functions secrets.
  ✅ TEST: sample map renders in app; a test Function reads both secrets.

### PHASE 1 — Data layer & trip sharing
- [x] **T-06** Implement Firestore schema (Section 4) as TS types + zod schemas in `shared/` (used by both app and functions).
  ✅ TEST: unit tests validate a fixture trip object against every schema.
- [x] **T-07** Anonymous auth on first load; create-trip flow generates `tripId` + 6-char shareCode; `joinTrip` Cloud Function adds UID to members by code.
  ✅ TEST: emulator test — device A creates, device B joins with code, both read the trip; a non-member read is rejected by security rules.
- [x] **T-08** Firestore security rules per Section 4 + rules unit tests.
  ✅ TEST: `firebase emulators:exec` rules tests pass (member CRUD ok, stranger denied).
- [x] **T-09** Enable offline persistence; Zustand store wiring; `useTrip(tripId)` live hook.
  ✅ TEST: E2E — edit settings in tab A, tab B updates < 3 s; airplane-mode reload still shows data.

### PHASE 2 — Trip setup UI
- [x] **T-10** Settings screen: full form per 7.1 incl. travelers rows, interests chips, Places autocomplete for start/finish, preferred countries, rest-day slider, max drive hours. All fields write to Firestore and are re-editable.
  ✅ TEST: E2E fills every field, reloads, values persist; editing any field flips `planMeta.status` to `stale`.
- [x] **T-11** Notes panel (the freeform "text file"): autosaving textarea + updatedAt stamp.
  ✅ TEST: type, wait, reload — text persists; second device sees it live.

### PHASE 3 — Planning engine (Cloud Functions)
- [x] **T-12** `generatePlan` function skeleton: triggers on `planRequests` write, sets status transitions pending→generating→ready/error, writes a hard-coded 3-day fixture plan.
  ✅ TEST: emulator — writing a request produces fixture days/activities/restaurants docs and `status: ready`.
  NOTE: the fixture described here was superseded once T-14/T-16 were wired in (see below) — `generatePlan` now runs the real pipeline unconditionally. `generatePlan.test.ts` was rewritten accordingly: it now proves the trigger correctly attempts the real pipeline and fails gracefully (a clear `planMeta.error`, not a crash) without `CLAUDE_API_KEY`/`GOOGLE_PLACES_API_KEY` configured, since this emulator has neither.
- [x] **T-13** Routes API integration: real distance/duration between stops; store polylines; compute `avgDriveMinutesPerDay`, `totalKm`.
  ✅ TEST: unit test with mocked Routes response; emulator run on Oslo→Rome fixture yields plausible totals (±10 % of known ~2,700 km).
- [x] **T-14** `planTrip` Claude call per 6.1 (includes notes text every time); zod-validate; one retry on parse/schema failure.
  ✅ TEST: recorded-response unit test parses to valid skeleton; live smoke test returns a plan honoring preferred countries and interests.
  NOTE: implementation + recorded-response unit tests (parse success, schema-violation, one-retry-then-succeed, retry-exhausted) are done and passing. `planTrip` is now called directly from `generatePlan` for every real plan request (no fixture fallback). Live smoke test against the real Claude API still needs to be run against a deployed instance with `CLAUDE_API_KEY` configured to confirm end-to-end quality, but the wiring itself is complete.
- [x] **T-15** Pacing validator per Section 5 incl. final-2-days rule and rest-day placement; violation → feedback retry → error status.
  ✅ TEST: unit tests: crafted violating plan is rejected with correct reason; valid plan passes.
- [x] **T-16** Places enrichment per 6.4: resolve every proposed item, enforce counts (5 activities, 3×3 restaurants) with backfill, store rating/link/photo/hours.
  ✅ TEST: unit test with mocked Places; live smoke: every activity/restaurant doc has rating + googleMapsUrl; counts exact on all days.
  NOTE: enrichActivities/enrichRestaurantsForMeal implemented (text search → quality-bar filter → nearby-search backfill, exact counts, shared exclude set across meals) with 5 mocked-Places unit tests passing. Now wired into `generatePlan`'s real per-day resolution step (`resolveSkeletonDay`), which also added a new `geocodeQuery` helper in `placesApi.ts` to turn Claude's overnight-stop text into coordinates before calling Routes/Places. Live smoke test pending a deploy with `GOOGLE_PLACES_API_KEY` configured, same as T-14.
- [x] **T-17** `replanTrip` per 6.2 preserving completed days.
  ✅ TEST: emulator — fixture trip mid-way, replan request → past days untouched, future days regenerated, pacing rules hold.
  UPDATE (2026-07-27): the "future days regenerated" half of this was only ever true in the loosest sense — see 6.2's new note above. `runReplan` now uses the real `planTrip` + `resolveSkeletonDays` pipeline instead of a 1-2-day fixture. `replanTrip.test.ts` rewritten to mock `planTrip`/`resolveSkeletonDays` at the module level and call `runReplan` directly (driving it through the Cloud Functions trigger would hit the real, unmocked pipeline in a separate emulator process with no credentials available) — now covers reindexing, past/locked-day preservation, the locked-day collision safety net, and that a failed replan preserves existing days rather than deleting them first.
- [ ] **T-18** `countryGuide` per 6.3 for each route country, cached; refresh callable.
  ✅ TEST: plan through 3 countries creates 3 guide docs with all six sections non-empty.
  NOTE: generateCountryGuide (Claude + web_search_20260209 tool, zod-validated with one retry) and the refreshCountryGuide callable are implemented and unit-tested against a recorded response covering all six sections. Still not auto-wired into generatePlan/replanTrip — country guides are generated separately (via the `refreshCountryGuide` callable from the Countries screen), not as part of the per-day plan pipeline, so this remains open. Live "plan through 3 countries" test pending a deploy with CLAUDE_API_KEY configured.

This completes Phase 3 (Planning engine). T-14 and T-16 are now fully wired into the live `generatePlan` pipeline (no fixture fallback remains — `generatePlan.test.ts` was rewritten to assert graceful failure without credentials rather than fixture success, and E2E specs seed fixture data directly via a new `e2e/helpers/seedFixturePlan.ts` helper instead of relying on the function's old hard-coded output). T-18 (`countryGuide`) is code-complete and unit-tested against recorded responses, but remains unwired from the generate/replan pipeline and its live smoke test is still blocked on CLAUDE_API_KEY.

### PHASE 4 — Overview map
- [x] **T-19** Map screen: polyline + start/end + overnight markers with day numbers; header shows total km, day count, **avg driving time/day**.
  ✅ TEST: E2E on fixture plan — markers count equals days; header numbers match Firestore.
  NOTE: header math (total km, avg drive min/day, day count) is E2E-tested against the real fixture plan (e2e/map.spec.ts). Marker rendering itself is implemented (route polyline, start/end pins, overnight day-number badges) but couldn't be E2E-verified in this sandbox — see T-20's note, same root cause.
- [x] **T-20** Zoom-based progressive disclosure per 7.2 with category icon set.
  ✅ TEST: E2E asserts marker counts at zoom 5, 7, 10, 13 follow the tiers.
  NOTE: the tier logic itself (z<6 route only, 6-8 overnight badges, 9-11 selected activities, >=12 everything) is pure-function unit-tested (src/lib/mapZoomTiers.test.ts, 4/4 passing) and wired into OverviewMapScreen.tsx via onCameraChanged. A marker-count E2E assertion against the live rendered map is NOT possible in this sandbox: the agent proxy's egress policy actively blocks the Google Maps JS API from loading inside the Playwright browser (confirmed via `curl $HTTPS_PROXY/__agentproxy/status`, which shows policy-denial 403s for Google domains from the browser context) — this is an infra restriction, not an app bug, and should re-test cleanly in a normal browser/CI environment with network access.
- [x] **T-21** Tap day badge/segment → navigate to Day View.
  ✅ TEST: E2E tap day 3 badge → Day View shows day 3's date.
  NOTE: the AdvancedMarker onClick → `navigate(/map/day/:dayId)` wiring is implemented in OverviewMapScreen.tsx. Because markers can't mount in this sandbox (see T-20's note), the E2E test instead navigates directly to `/map/day/2026-07-10` and verifies DayViewScreen renders "Day 1 — 2026-07-10" — proving the routing/data-fetch side of T-21, which is the same code path a real click would hit.
- [x] **T-22** Change interface: free-text change request + per-day lock toggles → replan request carrying that text.
  ✅ TEST: emulator — locked days survive replan; change text appears in the Claude call payload (assert via function logs/mock).
  NOTE: frontend (free-text + per-day lock checkboxes → `planRequests` doc with `changeRequestText`/`lockedDayIds`) and backend (`ReplanContext` extended with both fields; `runReplan` now excludes locked day IDs from deletion/regeneration, same as past days) are both done. Covered by an E2E test (submit flow) and a new functions emulator test (`replanTrip.test.ts`: "preserves locked days ... even when they fall in the future") verifying a locked future day's summary and activities subcollection survive untouched. The "change text appears in the Claude call payload" half remains blocked on CLAUDE_API_KEY, same caveat as T-14/T-16/T-18 — changeRequestText isn't consumed by planTrip.ts's prompt yet since that wiring itself is pending real credentials.

This completes Phase 4 (Overview map).

### PHASE 5 — Day view & execution
- [x] **T-23** Day View layout per 7.3: map top / content bottom, drive card with slot, card rows for 5 activities + 3×3 meals, prev/next + swipe cycling, rest-day banner. iPad split layout at `lg`.
  ✅ TEST: E2E on phone + iPad viewports; swiping cycles days without visiting overview.
  NOTE: map pane is a placeholder div (data-testid="day-map") — wiring it to an actual Google Map with highlighted pins is T-24's job. Card content (photo/name/category/rating/blurb) renders via a shared PlaceCard; Navigate links and Selected/Done controls are deliberately deferred to T-24/T-25 per the task split. E2E (e2e/dayview.spec.ts) covers phone (375×812), iPad portrait (820×1180), and iPad landscape (1180×820), plus a real touchstart/touchend swipe cycling through all 3 fixture days without ever hitting the overview route.
- [x] **T-24** Card ↔ map interaction: tap card highlights pin & pans; "Navigate" opens Google Maps link.
  ✅ TEST: E2E — tapping card N pans map to its coords; link href equals stored googleMapsUrl.
  NOTE: DayViewScreen now renders a real @vis.gl/react-google-maps map (overnight pin + a pin per activity/restaurant); a MapPanner child calls `map.panTo()` whenever the selected place changes, driven by either a card tap or a marker tap. Each card is a real button (aria-pressed reflects selection) with a "Navigate" link whose href is the stored googleMapsUrl (stopPropagation keeps it from also selecting the card). Live pixel-level pan verification is blocked by the same sandbox network policy as T-20/T-21 (Google Maps JS can't load in this Playwright browser), so the E2E test instead asserts the exact state the pan is driven from: aria-pressed flips true and a "Showing: <name>" caption appears with the tapped place's name. Added googleMapsUrl to two fixture places in generatePlan.ts so the Navigate-link assertion has real data to check against.
- [x] **T-25** Selected/Done states + diary notes; Done writes `log/` entry; Diary screen lists entries chronologically with share/export.
  ✅ TEST: E2E mark 2 done with notes → both appear in Diary; state syncs to second tab.
  NOTE: each PlaceCard now has Select/Done controls (src/lib/placeStatus.ts writes status directly on the activity/restaurant doc; Done additionally writes a `trips/{tripId}/log/{entryId}` doc with refPath/date/note per the schema). New DiaryScreen (route `/diary`, nav link in AppShell) lists `log/` chronologically, resolving each entry's place name via a one-time getDoc on its refPath, with an Export button (navigator.share when available, falling back to a downloaded .txt). E2E (e2e/diary.spec.ts) marks an activity and a restaurant done with notes on one device and confirms both show up live in the Diary on a second, joined device — the actual multi-device sync path, not a same-tab stand-in.
- [x] **T-26** Execution mode: date-gated GPS check on open + 30-min interval; >50 km behind → replan prompt with Snooze; manual-pin fallback when permission denied.
  ✅ TEST: unit test distance logic (49 km → no prompt, 51 km → prompt); E2E with mocked geolocation shows prompt and Snooze suppresses it for the day.
  NOTE: src/lib/executionMode.ts has the pure logic (haversineDistanceKm, shouldPromptReplan, isTripActiveToday), unit-tested including the exact 49/50/51 km boundary. useExecutionMode (mounted trip-wide in AppShell, so it's active on any screen once open) checks navigator.geolocation on mount + every 30 min while `today` falls in [startDate, endDate] and a day is planned for today, comparing position to that day's overnight stop. >50 km shows the ExecutionModePrompt banner with Re-plan (submits a real `kind:'replan'` planRequest) and Snooze (persisted in localStorage per trip+day, survives reload). On a geolocation error it shows a manual lat/lng "I'm here" fallback instead. E2E (e2e/execution-mode.spec.ts) seeds a real "today"-dated day via firebase-admin against the emulator (the app's own fixture generator only produces fixed 2026-07-10..12 dates), then drives all three paths: >50km prompt + snooze persistence, <50km silence, and a stubbed geolocation error triggering the manual-position fallback (real permission-prompt automation in this sandbox left the browser stuck in "prompt" state indefinitely, so the denied-permission path is exercised via a direct navigator.geolocation stub instead of relying on that plumbing).

This completes Phase 5 (Day view & execution).

### PHASE 6 — Country guide UI & polish
- [x] **T-27** Country tab + detail accordions for the six sections; refresh button.
  ✅ TEST: E2E — every route country listed; all sections render; refresh updates `generatedAt`.
  NOTE (superseded 2026-08-02 — see the research-brief entry at the end of this file; the per-trip `countries/{code}` document and the whole-guide `refreshCountryGuide` callable are gone): new CountriesScreen (`/countries`) lists the unique countries across `days` (flag + name, deduped by `EUROPEAN_COUNTRIES`); CountryDetailScreen (`/countries/:code`) renders the six sections as native `<details>` accordions and a "Refresh info" button calling the existing `refreshCountryGuide` callable. E2E (e2e/countries.spec.ts) confirms every route country is listed and, via a guide seeded directly through firebase-admin (mirroring T-26's approach, since there's no live-generated guide to test against), that all six sections render with real content. The "refresh updates generatedAt" half is blocked on CLAUDE_API_KEY like T-14/16/18/22 — the test instead confirms the call fails *gracefully* (a visible error, not a crash) when the secret is missing.
- [x] **T-28** Responsive/offline audit per Section 8 across the three viewports; offline banner for map.
  ✅ TEST: Playwright viewport suite green; offline reload shows day cards + banner.
  NOTE: audited Setup/Map/Diary/Countries at 375×812, 820×1180, 1180×820 — no horizontal scroll on any of them. The audit caught AppShell's nav links and the Map screen's "Request changes" button sitting well under the 44px tap-target minimum (measured ~20px); fixed with `min-h-11` + padding. Added a new `useOnlineStatus` hook and an offline banner on the Map screen (`data-testid="offline-banner"`) — going offline and reloading still shows the header's cached day/km/drive-time numbers (from Firestore's persistentLocalCache) alongside the banner; only the Maps JS tiles themselves need network, per spec. E2E: e2e/responsive-offline.spec.ts.

- [x] **T-29** Cost guards: request debouncing, single pending planRequest enforcement, photo size caps.
  ✅ TEST: hammering Generate creates exactly one active request.
  NOTE: photo size caps were already done in T-16 (`maxWidthPx=400` on the Places photo media URL). Added two new layers here: (1) client-side debounce — SettingsScreen's Generate/Re-plan button disables its own DOM node synchronously inside the click handler (a `useState` alone re-renders too slowly to catch clicks fired faster than React's commit), so a real rapid multi-click only ever fires one `addDoc`; (2) server-side enforcement — `generatePlan`'s trigger now opens with a Firestore transaction that reads the trip's `planMeta.status` and atomically claims it (sets 'pending') only if no request is already active, rejecting any request that loses the race with a clear error, closing the gap two *different* devices hammering Generate at once could hit. Unit-level (functions/src/costGuards.test.ts) deterministically proves the transactional guard rejects a request while another is mid-flight; E2E (e2e/cost-guards.spec.ts) dispatches 5 native clicks in one JS tick and confirms exactly one `planRequests` doc exists afterward. (Note: testing this via Playwright's own concurrent `locator.click()` calls proved flaky — its per-call actionability checks can race independently of the page's JS thread; dispatching real DOM clicks via `page.evaluate` reproduces genuine rapid-click behavior deterministically.)
- [ ] **T-30** Production launch: restrict keys to prod domain, deploy `main` to live channel, install on both phones + iPad, generate the real trip.
  ✅ TEST: full manual walkthrough of the Acceptance Checklist (Section 10) on real devices.

---

## 10. REQUIREMENTS TRACEABILITY — tick when verified end-to-end

Verified end-to-end 2026-07-27 (per the user's request) — each item checked against real code, not memory; one gap found and fixed (see below), one minor labeling inconsistency flagged as a conflict rather than fixed (out of scope for this pass).

- [x] Inputs: dates, travelers + kids' ages, interests, start/finish, preferred countries (T-10) — `SettingsScreen.tsx`: date/place/traveler/interest/country inputs, all wired to `commit()`/`updateTripSettings`.
- [x] Freeform notes "text file", editable, persisted, injected into every plan/replan (T-11, T-14, T-17) — `NotesScreen.tsx` persists `notes.freeText`; `planTrip()` takes it as `notesFreeText`; `runReplan` folds it (plus `changeRequestText`/`behindScheduleKm`) into the same field.
- [x] Inputs saved between sessions & editable (T-09, T-10) — `useTripSession`'s `localStorage.tripId` + Firestore persistence; `settings.spec.ts` covers reload.
- [x] Even pacing, no huge final drive (T-15) — **re-verified and corrected 2026-08-12**: the 1.4x cap / 1.0x relaxed finish this line claimed as the hard check had already stopped being one (see Section 5's first revision) — they live in `PACING_RULES` (`functions/src/prompts/planTripPrompt.ts`) as generation guidance. What is actually enforced is `validatePacing`'s 1.5 × `maxDriveHoursPerDay` and the rest-day-stays-put rule; distribution across the trip is now covered by `pacingWarnings`' advisory back-loading check, which is not a gate. All in `pacingValidator.ts`, tested in `pacingValidator.test.ts`.
- [x] Extra time for deserving attractions (T-14 `extraTimeReason`) — `dayDetailSchema.extraTimeReason`, generated by `DETAIL_SYSTEM_PROMPT`, shown on Day View ("Why here: …").
- [x] Rest days ~1/week, selectable in input (T-10, T-15) — `restDayFrequency` slider on Settings; `PACING_RULES` rule 5.
- [x] Per day: drive + 5 activities + 3×3 restaurants (T-16) — `ACTIVITIES_PER_DAY = 5`, `RESTAURANTS_PER_MEAL = 3` × 3 meals (`placesApi.ts`), enforced by backfill and tested.
- [x] Drive slot morning/midday/evening linking to next day's activities (T-14, T-23) — **gap found and fixed 2026-07-27**: the slot was stored (`driveLegSchema.slot`) and displayed (`DayViewScreen`'s drive card), but `DETAIL_SYSTEM_PROMPT` never told Claude to actually use it — a "morning" drive day could get activities as if the whole day were free, or an "evening" drive day could get activities near a town not reached until nightfall. Fixed with an explicit instruction covering all four cases (morning/midday/evening/rest).
- [x] Route on interactive map with best stops (T-19) — `OverviewMapScreen.tsx`: `Polyline` + day-badge markers for every overnight stop.
- [x] Zoom → progressively more stops; close zoom shows all with type icons (T-20) — `mapZoomTiers.ts`, tested in `mapZoomTiers.test.ts`.
- [x] Change-request interface (T-22) — trip-wide (`OverviewMapScreen`) and per-day (`RequestChangesForDay`, added this session) variants, both submitting through `submitPlanChangeRequest`.
- [x] Average driving time per day displayed (T-19) — `header-avg-drive-minutes` in `OverviewMapScreen`.
- [x] Click map segment → Day View; cycle days without overview (T-21, T-23) — day-badge `onClick` navigates to `/map/day/:dayId`; `DayViewScreen`'s prev/next arrows + swipe handler.
- [x] Map on top, activities below (T-23) — `DayViewScreen.tsx`'s layout: map `div` first, activities/meal `CardRow`s below (stacked on phone, side-by-side on wider viewports).
- [x] Execution prompt when >50 km behind plan (T-26) — `BEHIND_PLAN_THRESHOLD_KM = 50` in `executionMode.ts`; just fixed a real bug in the replan this triggers (see recent commit — it could suggest an even longer drive instead of an easy catch-up day).
- [x] Cards show info, Google rating, Google Maps link; click shows on map (T-24) — `PlaceCard.tsx`: rating, `googleMapsUrl`, `onTap` → `selectedPlace` → `MapPanner`.
- [x] Mark done → log/diary (T-25) — `markDone` (`src/lib/placeStatus.ts`) writes a `log` entry; `DiaryScreen.tsx` reads it.
- [x] Country info: driving rules, camping, free camping, road fees & payment, speed limits (3,500 kg car-registered), LPG refill (T-18, T-27) — those six are now the *defaults* of an editable per-traveler research brief (`shared/src/countryBrief.ts`), researched one section at a time into `countryGuideSections` and rendered in `CountryDetailScreen.tsx`. `countryGuideSchema` — the fixed six-topic shape this line originally named — is gone; the per-section `countryGuideSectionSchema` replaced it. Updated 2026-08-12 (the change itself landed 2026-08-02).
- [x] Data saved but easily modified; stale→replan flow (T-10, T-17) — `updateTripSettings` flips `planMeta.status` to `'stale'` on any edit; Settings shows "Re-plan trip" for that status. **Conflict flagged, not fixed**: this flip happens even on a trip that's never been generated at all (`status: 'idle'`, no prior plan) — editing settings before ever generating once would show "Re-plan trip" instead of "Generate plan" for a trip with nothing to re-plan. Cosmetic only (the same `generatePlan()`/`kind:'full'` call runs either way, so behavior is correct — only the button label is momentarily wrong), out of scope for this pass, noted here for a future cleanup.
- [x] Same plan live on two phones (T-07, T-09) — Firestore `onSnapshot` throughout; `sync.spec.ts` covers real-time sync across two contexts.
- [x] iPad compatible / responsive (T-23, T-28) — `responsive-offline.spec.ts` covers phone/ipadPortrait/ipadLandscape viewports and 44px tap targets.
- [x] GitHub + Firebase (T-01–T-03) — this repo, deployed via `.github/workflows/ci.yml`'s Firebase Hosting/Functions/Firestore-rules deploy job on pushes to `main`, or on demand via `.github/workflows/deploy.yml` (manual dispatch, target picker). Updated 2026-08-10.

---

## 11. BACKLOG — discussed, not yet implemented

Recommendation (agreed with the user 2026-07-27): land the current baseline as a PR first, then work these incrementally rather than bolting them onto an ongoing bugfix session. Each is a real, separately-scoped design problem.

Update 2026-07-27 (later same day): worked through this list per the user's explicit request. Landed: both bugs (day numbering, highlightReason drift), manual editing (skip status + add custom stop), per-day request changes, and map UI polish (marker badges + selection highlight, item 3.1 of the Select redesign only). Held for design review before implementation (per the user).

Update 2026-07-27 (later still): design proposals written up and reviewed with the user for the 3 held-back items; all 3 then implemented per the user's go-ahead, with an explicit investigation step first for overnight-stop lookup strategy (see that item's note — real data sources checked before committing to an approach, not guessed). All 3 now done: resumable/checkpointed generation (generatePlan only), interactive/transparent route planning (skippable highlights-review pause, scoped v1), overnight-stop type & candidates (lazy per-day resolution, scoped replan on pick). Deferred as bigger/lower-priority: multi-trip support, dismiss-and-requeue, selected-activities-route-awareness, the Node runtime bump, and the remaining Select-redesign extensions (2–4). Skipped: diary photo attachments (needs new Storage infra + real iOS device testing this session can't provide).

- [x] **Multi-trip support ("trip library")** (deferred 2026-07-27; requested again and implemented 2026-07-30, following this same entry's own design notes) — built exactly as scoped above, all three pieces:
  - **Reverse index**: `users/{uid}/trips/{tripId}` (`{ joinedAt }`, no shared zod schema — matches `trips/{tripId}/members/{uid}`'s own precedent of being an untyped internal doc on both ends), written alongside the existing `members` doc — inside the same transaction in `createTripForUser`, and via a new atomic `batch()` (replacing what used to be a bare `.set()`) in `joinTripByCode`, so a share-code join lands in the joiner's own trip list too, not just grants access. `firestore.rules` gained `users/{uid}/trips/{tripId}`: `allow read: if request.auth.uid == uid`, `allow write: if false` (Admin SDK bypasses it, same pattern as `members`).
  - **"New Trip" action**: `useTripSession.ts` now exposes `uid`, `switchTrip(id)` (just a localStorage + state write — membership already exists, no backend call needed), and `startNewTrip()` (calls the existing `createTrip` callable again, no backend change needed there per this entry's own note). New `useMyTrips(uid)` hook lists the reverse index live, then one-shot-fetches each trip's `meta`/`settings`/`planMeta.status` for display (small trip counts, per-trip reads are fine — also per this entry's own note).
  - **Trip switcher**: new `TripSwitcher.tsx`, same lightweight non-modal `<details>` toggle pattern as the existing `ShareTripMenu`, placed right next to it on Trip setup (`AppShell.tsx`'s setup-page header) — lists every trip with its name/dates, highlights the active one, and has the "+ New trip" button.
  - **Empty name on a new trip** (explicitly requested): `defaultTrip()`'s `meta.name` changed from the literal `'New Trip'` to `''` — applies to every trip, including the very first one auto-created on a brand-new browser, so the name field always reads as genuinely empty and ready to type into rather than placeholder text to notice and clear. The input gained a `placeholder="Name your trip"` so an empty field still reads as intentional, not broken.
  - **Diary already scoped per trip — verified, not built**: `useLog`/`DiaryScreen` and `markDone`'s write path (`src/lib/placeStatus.ts`) were already fully qualified under `trips/{tripId}/log`, same as every other subcollection (`days`, `countries`, `corridorStops`). A new trip's `log` subcollection is simply empty by construction — no code change needed for "a new trip should yield an empty diary," confirmed by e2e rather than assumed.
  - **Found and fixed along the way**: `?join=CODE` used to overwrite `localStorage.tripId` unconditionally and never clear the param from the URL. Harmless before (the effect only ran once per page load), but a real bug the moment trip-switching exists — a stale `?join=` would silently re-hijack whatever trip the traveler had since switched to on the next full reload. Fixed: `useTripSession.ts` now strips `?join=` via `history.replaceState` once handled.
  - **Deliberately not built** (not asked for, real added scope): renaming a trip beyond the existing name field, deleting/leaving a trip, and anything around real (non-anonymous) sign-in — flagged during investigation that losing the browser's anonymous Firebase Auth identity (cleared storage, new device) loses access to every trip in the library, with a trip's own share code as the only recovery path. Not fixed here; would need actual account sign-in, a materially bigger feature.
  - Covered by: extended `functions/src/trips.test.ts` (reverse index written by both `createTripForUser` and `joinTripByCode`, accumulates across multiple trips rather than replacing, cross-user read denial); extended `functions/src/firestore-rules.test.ts` (own-list read, stranger denial, no client write); new `e2e/trip-management.spec.ts` (New Trip button creates a distinct trip with an empty name; switching trips shows each one's own diary and a new trip starts with an empty one; joining by share code adds to the switcher without losing the trip already active, and the `?join=` param doesn't linger).

- [x] **Resumable / checkpointed plan generation** (held for design review 2026-07-27; design proposed and implemented 2026-07-27, generatePlan only per the user's answer — a replan's remainder is short enough that redoing it from scratch isn't the expensive case this solves for) — `generatePlan.ts` used to build the whole plan in memory (all three `planTrip` phases, then every day's Places/Routes resolution in `resolveSkeletonDay`) and write to Firestore exactly once, in a single batch, at the very end. Any failure at any point — including the pacing check, which runs *after* all Places/Routes enrichment — discarded everything, and "Retry" reran the entire pipeline from zero. Implemented: `planCheckpoint.ts` stores the skeleton + a settings hash on `planMeta.checkpoint` right after the highlights/outline/detail phases succeed, and stages each resolved day into `trips/{id}/generationStaging/{index}` as it resolves (awaited, not fire-and-forget — the whole point is surviving a crash between one day and the next). A retry with unchanged settings resumes from the checkpoint; a retry after settings changed discards the stale checkpoint and starts clean. Cleared on success. Covered by `functions/src/generatePlan.checkpoint.test.ts`.

- [x] **Interactive / transparent route planning** (held for design review 2026-07-27; design proposed and implemented 2026-07-27 — a scoped v1, not the full "hard nut to crack" vision) — current generation is a black box: settings in, finished plan out, no visibility into *why* particular towns were chosen beyond the per-day `highlightReason` (Section 6.1). The user's ask: surface the planning stage's reasoning and let the traveler choose between options. Implemented as a skippable pause (off by default — a checkbox on Settings, "Review suggested regions before generating") right after the highlights phase, which already produces exactly the data this needed: ranked candidate stops per region with a reasoning string, previously never shown. `planTrip.ts` split into `generateRegionHighlights` (phase 1) and `generateSkeletonFromHighlights` (phases 2-3) — `planTrip()` itself is unchanged, just both in sequence. `generatePlan.ts` pauses at `planMeta.status='awaiting-highlights-review'` with the highlights attached, and a new `continueFromHighlights` planRequest kind resumes into phases 2-3 with the traveler's edits (re-ranked priority tiers via up/down buttons and drag-and-drop, removed candidates, an optional free-text note). Scoped to fresh generation only, not replan. NOT implemented (deferred, bigger v2): a second pause after the outline phase, or generating true alternate-route variants. **Retired 2026-07-29** — see "Persistent, always-editable route corridor on the Map tab" below (item 5, its own "Retire" sub-bullet), the v2 this entry deferred, which supersedes this ephemeral pause with a persistent equivalent; `functions/src/generatePlan.reviewPause.test.ts` and `e2e/highlights-review.spec.ts` were deleted along with it.

- [x] **Manual editing of individual activities/restaurants** (implemented 2026-07-27) — there is currently no way to add a stop the AI didn't suggest, or remove/skip one it did. The only manual levers today are trip-level settings/notes (reshape the *next* AI generation, nothing narrower) and per-item status via `markSelected`/`markDone` (`src/lib/placeStatus.ts`) — Select and Done only. Notably `itemStatusSchema` (`shared/src/schemas.ts`) already defines a `'skipped'` value that no UI ever writes. Scoped cheap first: activities/restaurants are just documents in a `days/{dayId}/activities|restaurants` subcollection with a fixed schema — whether Claude or a person authored them makes no difference downstream (Day View, map, diary all just read the schema) — so this doesn't need to touch the AI pipeline at all. Done: `markSkipped` (`src/lib/placeStatus.ts`) wired to a Skip button in `PlaceCard`; `restaurantSchema`'s own narrower status enum (missing `'skipped'` entirely) now reuses `itemStatusSchema` like `activitySchema` always did; `AddCustomStopForm` on Day View writes a new activity/restaurant doc directly via `activitySchema`/`restaurantSchema` validation, using `PlaceAutocompleteInput` for location. Covered by `e2e/manual-editing.spec.ts`.
  - ~~Wire the existing `'skipped'` status to a button next to Select/Done in `PlaceCard`.~~
  - ~~Add an "Add custom stop" form on Day View that writes a new doc directly into the relevant subcollection with `status: 'selected'`, using the same `activitySchema`/`restaurantSchema` shape (name, category/meal, lat/lng — could reuse `PlaceAutocompleteInput` for the location instead of asking for raw coordinates).~~
  - Explicitly NOT in scope here: manually adding/removing/reordering whole overnight days — that's a bigger structural change (days are pacing-linked to the drive legs between them) closer in spirit to the interactive-planning item above.

- [x] **Map UI polish: marker size and selection highlight** (screenshot 2026-07-27; core fixes implemented 2026-07-27) — both `DayViewScreen.tsx` and `OverviewMapScreen.tsx` render markers as bare emoji (`CATEGORY_ICON`/`RESTAURANT_ICON`/`OVERNIGHT_ICON`, `src/lib/mapIcons.ts`) inside `<AdvancedMarker>` with no size/background styling, so they render at default browser font-size — tiny and hard to tap, especially at the zoom levels real restaurant clusters show up at (see screenshot: several overlapping pins in Varberg's old town). Three fixes, all touching the same markers/cards so likely worth doing together:
  1. ~~Wrap each marker's icon in a sized/padded container (e.g. a circular badge) instead of a bare `<span>`, in both screens.~~ Done: new shared `MarkerBadge` component (`src/components/MarkerBadge.tsx`), used by every marker in both screens.
  2. ~~Day View already tracks `selectedPlace`... Give the marker matching `selectedPlace.id` a distinct look...~~ Done: `MarkerBadge`'s `highlighted` prop (orange ring + scale, matching `PlaceCard`'s own tap-to-view color) in `DayViewScreen.tsx`.
  3. **"Select" redesign (2026-07-27 report — "selecting things doesn't seem to do anything"; investigated same day).** Correction to the first read of this: `status: 'selected'` (set by the card's "Select" button — "this is actually in my plan", distinct from `selectedPlace`'s transient tap-to-view state above) is NOT entirely inert — `mapZoomTiers.ts`'s original Section 7.2 spec ("9–11: selected activities") is real and wired up in `OverviewMapScreen.tsx`: at zoom 9–11, only activities with `status === 'selected'` render as pins. But that's the *only* place it has any effect: it doesn't touch Day View at all (where the Select button actually lives — `PlaceCard.tsx` only changes a small gray "Status: selected" text label there, no border/color change), it's invisible unless you're on a *different* screen at a specific zoom band, and restaurants get no equivalent filtering at all (always all-hidden or all-shown, never gated by selection). That mismatch — click Select, look at the same screen you clicked it on, see nothing — is almost certainly the whole complaint. Beyond just fixing visibility, a more useful design (ranked by value):
     1. ~~**Immediate feedback where you clicked it** (the real fix for the reported bug): a real visual state on the card for `status === 'selected'` distinct from the tap-to-view highlight, and Day View's own map (not just Overview Map) distinguishing selected pins from merely-suggested ones.~~ Done 2026-07-27: `PlaceCard` shows a blue ring for `status === 'selected'` (distinct from the orange tap-to-view ring), and `MarkerBadge`'s `selected` prop reflects it on both Day View's own map and Overview Map (activities and restaurants, not just activities).
     2. **Turn the AI's shotgun of options into "our plan"** (deferred 2026-07-27 — bigger, held back with the other larger items): 5 activities and 9 restaurants a day is a menu, not an itinerary. A toggle on Day View ("All suggestions" vs "Our picks") showing only selected items would make Select the actual curation step it's meant to be, instead of a side note buried under suggestions.
     3. **Extend the existing Overview Map zoom-tier filtering to restaurants** (deferred 2026-07-27, same reasoning), consistent with activities, instead of today's all-or-nothing behavior.
     4. **Feed selections into replan** (deferred 2026-07-27, same reasoning): a "Request changes" replan currently has no notion of what was already selected for a day being regenerated; a selected-but-not-done item could be treated as a soft preference to try to preserve, similar to how locked days already survive verbatim (lower priority than 1–3). No longer blocked on replan's own wiring — `runReplan` now runs the real pipeline (see 6.2/T-17) — this would mean passing selected items into the remainder's prompt context, similar to how `changeRequestText` is folded into the notes today.

- [x] **Overnight-stop type & candidate selection** (requested 2026-07-27; held for design review 2026-07-27; investigated and implemented 2026-07-27) — there was no way to choose *where* to sleep beyond whatever single point the AI picked. Investigated actual lookup strategies before implementing rather than guessing: Google Places (New) has `rv_park` + `campground` (solid, same quality bar as activities/restaurants); Park4Night has no sanctioned API (creators explicitly don't want third-party use) and iOverlander's export is personal-use-only by its own ToS, but OpenStreetMap has a purpose-built tag for stellplatz (`tourism=caravan_site` + `caravan_site=motorhome_stopover`), queryable via the public Overpass API; wild-camping legality has no structured database anywhere and needs Claude + web search grounded in the country's own `freeCampingRules`.
  - `TripDay.overnight` deliberately stays a single committed point (no schema change) — switching it ripples into every following day's drive leg, so candidates are resolved lazily (only when "Change overnight" is opened on Day View, via the new `getOvernightCandidates` callable) rather than for every day at generation time, and returned directly to the client rather than stored.
  - Picking a candidate submits a scoped replan (locking every day before it, reusing `submitPlanChangeRequest`) instead of a client-side write with cascading staleness.
  - Stellplatz falls back to Claude+web_search only where OSM has no coverage nearby. Wild-camping suggestions get a one-time dismissible caveat in the UI; OSM results carry ODbL attribution.
  - Covered by `functions/src/overpassApi.test.ts`, `functions/src/overnightCandidatesCallable.test.ts`, `functions/src/prompts/overnightCandidates.test.ts`, and `e2e/manual-editing.spec.ts`.

- [x] **GPS-based execution tracking** — confirmed already implemented, not a gap: `useExecutionMode` (`src/hooks/useExecutionMode.ts`, mounted trip-wide in `AppShell`) polls `navigator.geolocation` every 30 min while the trip is active, compares position to today's planned overnight stop, and prompts a replan past the 50km threshold (Section 7.4). No action needed.

- [x] **Diary export** — confirmed already implemented (`src/screens/DiaryScreen.tsx`), not a gap: native share sheet with a text-file download fallback. Noted here only because it was re-requested without realizing it existed — if the format itself (currently a bare `date — type: note` line per entry) needs to be richer, that's a small follow-up, not a new feature.

- [x] **Trip-sharing UX** (surfaced answering "how would the trip be shared between devices" 2026-07-27, implemented same day) — done: `AppShell.tsx` now has a "Copy link" button next to the share code and a manual "Enter a share code" input as a friendlier entry point to the existing `?join=CODE` flow. Also fixed along the way: the share code used to only ever display once, right at trip creation — `useTripSession`'s `shareCode` state was never set on a normal reload (only on the `createTrip` branch), so it silently vanished on every visit after the first. Now read from `trip.meta.shareCode` (always present) instead of that transient session state.

- [ ] **Deploy-time maintenance warnings (not yet blocking)** (deferred 2026-07-27 — 3 months of runway left, and this touches every Cloud Function so it's worth its own isolated pass) — surfaced during a `firebase deploy` on 2026-07-27, not urgent but with a real deadline:
  - `functions` runtime is Node.js 20 (`functions/package.json`'s `engines.node: "20"`). Google deprecated it 2026-04-30 and will **decommission it 2026-10-30** — after that date, deploys fail outright until the runtime is bumped (a currently-supported Cloud Functions Gen 2 runtime, e.g. Node 22, per https://cloud.google.com/functions/docs/runtime-support). Do this as its own deliberate upgrade-and-test pass, not a drive-by bump — Node major version changes can have real behavioral differences worth running the full test suite against before trusting.
  - `firebase-functions` is pinned to `^7.2.5`; npm's `latest` dist-tag was `7.3.2-rc.0` as of this check. Worth bumping alongside the runtime upgrade (`npm install --save firebase-functions@latest` in `functions/`) rather than as a separate change, since a runtime bump is the natural time to also pick up SDK fixes.

- [x] **"Request changes" should be reachable from Day View, scoped to that one day** (requested 2026-07-27; implemented 2026-07-27) — confirmed: the whole flow (`request-changes-button`, `change-request-text`, per-day `lock-toggle-*` checkboxes, `submit-change-request`) lives only in `OverviewMapScreen.tsx` — there's no equivalent entry point on `DayViewScreen.tsx`. The underlying mechanism already supports exactly what's being asked for: a replan submits `lockedDayIds` (days to leave untouched) alongside the free-text request, so "change just this day" is really "lock every day except this one." Done: extracted the submit logic into `submitPlanChangeRequest` (`src/lib/submitChangeRequest.ts`), reused by a new `RequestChangesForDay` component on Day View, pre-populating `lockedDayIds` with every day except the one currently being viewed. Covered by `e2e/manual-editing.spec.ts`.

- [x] **Dismiss-and-requeue for activities/restaurants, pre-fetched to avoid lag** (requested 2026-07-27; deferred 2026-07-27 — bigger, needs a generation-time backend change; picked back up and implemented 2026-07-30, extended with a second tier, generalized to selecting, then split into per-skip vs. whole-pool semantics, all 2026-07-30 — see the trail of user corrections below) — two tiers, with skip and select triggering them on different thresholds:
  - **Skip = "not interested, show me something else."** Reported live: "clicking skip does not bring up a fresh alternative" — the original implementation only refilled once a scope's *entire* live-`'suggested'` pool hit zero, so skipping one of several still-suggested items correctly did nothing by that rule, but wasn't what was wanted. Fixed: every skip now always tries to bring in exactly one replacement, regardless of how many other suggested items remain.
  - **Select = "keeping this one."** Several items can be selected at once (no "only one selected" rule anywhere in this app), so "all 5 selected," "1 selected, the other 4 skipped," etc. are all the same "nothing left to actually browse" state — select only refills once that whole pool is drained, per the user's own explicit logic ("if 1, 2, 3, 4, 5 are selected… more should render until the full re-research is needed"). Reverting a selection back to suggested only grows the pool, so it never triggers a refill.
  - **Tier 1, instant, no round-trip:** `enrichActivities`/`enrichRestaurantsForMeal` (`functions/src/placesApi.ts`) resolve `RESERVE_ACTIVITY_COUNT` (2) / `RESERVE_RESTAURANTS_PER_MEAL` (1) extra items beyond the displayed count at generation time, stored with `reserve: true` (optional field on `activitySchema`/`restaurantSchema`) — invisible everywhere (`useDayDetail` filters them out before any consumer sees them) until promoted. The shared per-category backfill loop was factored into `backfillActivities`/`backfillRestaurantsForMeal` so both the displayed-count fill and the reserve fill (and tier 2 below) share one implementation rather than three copies.
  - **Tier 2, live top-up:** the `researchMoreAlternatives` callable (`functions/src/researchMoreAlternativesCallable.ts`), called once tier 1's reserve is also exhausted. Anchors the search at an already-resolved item's own coordinates rather than always falling back to the day's overnight point, and excludes every place already shown or already dismissed for that day/meal via a `placeId` field (also added to both schemas). Takes a `visibleCount` (defaults to the full `RESEARCH_BATCH_SIZE`, used by select's whole-pool refill): only the first `visibleCount` of a fresh batch are written immediately visible, the rest go back in as `reserve: true` — so skip's single-replacement calls (`visibleCount: 1`) top the reserve buffer back up instead of dumping the whole batch into the row, letting a run of consecutive skips keep being served instantly rather than hitting Places every time. No busy-guard: purely additive (only ever appends new docs), same reasoning as phase 3's `rescanCorridor`.
  - **Client (`src/lib/placeStatus.ts`):** a shared `promoteReserveOrResearch` helper promotes a reserve doc in place if one exists, or calls the research callable otherwise. `skipAndRequeue` always calls it (`visibleCount: 1`) after marking skipped; `selectAndRequeue` first checks whether the scope's live-suggested pool is actually empty before calling it (with the default `visibleCount`). `DayViewScreen.tsx`'s `PlaceCardSection` routes both the Select and Skip buttons through their respective functions (`advance(placeId, 'select' | 'skip')`) and shows "Looking for more options…" / "Found more options nearby." / "No more nearby options found." in the row's footer alongside the existing "show skipped" toggle.
  - Covered by: extended `functions/src/placesApi.test.ts` (reserve items resolved, marked, and returned alongside the displayed ones); extended `functions/src/researchMoreAlternativesCallable.test.ts` (excludeIds/near derivation, meal scoping, not-found, `visibleCount` default vs. capped); `e2e/manual-editing.spec.ts` tests covering both the skip- and select-triggered cascade (reserve promotion end-to-end through the real UI for each action, including skipping one of several still-suggested activities; the credential-less "no more options" degradation once both tiers are exhausted, same pattern as every other Places/Claude-touching e2e test in this sandbox).

- [ ] **Diary photo attachments, attached at "Done" time, iOS-first** (requested 2026-07-27; skipped for now 2026-07-27 — needs a new Firebase Storage bucket + upload security rules (a new billed resource) and the request explicitly calls for building/testing against real iOS Safari first, neither of which this sandbox can provision or verify) — `markDone` (`src/lib/placeStatus.ts`) and `logEntrySchema` (`shared/src/schemas.ts`) currently only carry a text `note` — no photo field, and the app has no Firebase Storage integration anywhere yet (this would be new: a Storage bucket, upload security rules, and a schema field for a photo URL/path on the log entry, likely with the same `maxWidthPx`-style size discipline already applied to Places photos). UI: attach photo capture to the existing "Done" flow (`PlaceCard.tsx`'s note-input step) rather than a separate step. Explicitly build and test against iOS Safari first per the request — `<input type="file" accept="image/*" capture="environment">` is the standard way to trigger the native camera/photo-library picker there, and mobile upload should compress client-side before upload given real-world RV-trip network conditions.

- [ ] **Selected activities should feed back into route/travel-time awareness** (requested 2026-07-27; deferred 2026-07-27 — bigger, held back with the other larger items) — extends the already-logged "Select" redesign item: right now `TripDay.drive` is a single leg between yesterday's and today's overnight stop only (`routesApi.ts`/`resolveSkeletonDay` in `generatePlan.ts`) — there's no concept of the travel required *between* today's overnight and today's selected activities, or between the activities themselves. So selecting several activities spread across a wide area gives no visibility into the realistic extra driving/time that implies; the plan's distance/pacing numbers are blind to what's actually been selected. Would need computing (likely client-side, on demand, via the same Routes API path) a rough tour distance across a day's overnight + selected activities once selections are made, surfaced somewhere near the day's drive card.

- [x] **"Why here" reasoning isn't guaranteed to appear in the day's actual activities** (bug, reported 2026-07-27 — Oslo trip: "Tryvann Bike Park" named in a day's `highlightReason` but absent from that day's activities list; fixed 2026-07-27) — root cause: `highlightReason` is produced by the outline phase (Section 6.1's phase 1, reasoning about why a *town* was chosen) while activities are produced independently by the detail phase (phase 3) for that town. The detail phase's prompt (`buildChunkDetailPrompt`/`DETAIL_SYSTEM_PROMPT`, `functions/src/prompts/planTripPrompt.ts`) does receive the full outline (including every day's `highlightReason`) as context, but nothing in its instructions requires it to actually include the specific place a day's `highlightReason` named — so the two can drift apart, undermining the entire point of adding `highlightReason` in the first place (justifying a stop, then not delivering on it). Fixed: `DETAIL_SYSTEM_PROMPT` now explicitly requires it (`functions/src/prompts/planTripPrompt.ts`).

- [x] **On iOS Safari, focusing a field on Trip setup (e.g. "Finish point") opens the keyboard with the field scrolled off the top — only found by scrolling back up** (bug, reported 2026-07-30 with screenshots; fixed 2026-07-30, unverified on a real device) — root cause: `AppShell.tsx`'s `<main>` is a fixed `h-svh` flex column (deliberately, see its own comment — WebKit needs a definite height for `flex-1` children like the map screens to fill) with the actual page content scrolling in a *nested* `overflow-y-auto` div, not the document itself. iOS only resizes the *visual* viewport for the keyboard, not the layout viewport `h-svh` resolves against, and its native "scroll the focused field above the keyboard" behavior targets document-level scroll — it doesn't reliably reach into a nested scroll pane, leaving the field wherever the document happened to be scrolled. Fixed: a `window.visualViewport` `resize` listener in `AppShell.tsx` re-scrolls whatever's actually focused into view once the keyboard finishes animating open. Walks into `shadowRoot.activeElement` first, since `document.activeElement` alone would only report the shadow host for the specific field in the report — `PlaceAutocompleteInput`'s Google `PlaceAutocompleteElement` renders its real `<input>` inside an open shadow root. Applies to every field app-wide, not just Places fields, since the underlying nested-scroll-pane cause applies to all of them equally. **Not verified against a real iPhone/iOS Safari** — this sandbox has no device to test the actual keyboard/viewport interaction on; Playwright's headless Chromium doesn't reproduce iOS's visual-viewport keyboard behavior, so there's no automated coverage for this one either.

- [x] **Overview map's route ignored selected restaurants, and the day map never drew a route at all** (bug + feature request, reported 2026-07-30 with screenshots; fixed 2026-07-30) — three related reports handled together, since the fix is one shared ordering algorithm:
  - **"Not all day activities are shown... I selected a breakfast stop, so the route should go to that first. But it's not even showing."** Root cause, confirmed by inspection: `buildOverviewRoutePoints`/`selectDayAnchors` (`src/lib/buildOverviewRoute.ts`) only ever read `Activity` documents — `Restaurant` was never part of the route-point computation at all, at any zoom level or selection state. Not related to trip length (the 2-day trip in the report) — a selected breakfast/lunch/dinner stop had zero effect on the drawn route on any trip.
  - **"The routing should always be shown, also when inside a day planning mode."** Confirmed: `DayViewScreen.tsx` drew markers only — no polyline/route at all, despite `master_plan.md`'s own original Day View spec saying it should. The day's drive distance/time existed only as text in the `drive-card` below the map.
  - **"When selecting activity, it should be possible to select morning, evening, night or all day... routing should be updated according to this: Breakfast, morning activity if selected, lunch, evening activity if selected, dinner, night activity if selected, overnight stop (if evening drive is selected). If morning drive is chosen, then it should be breakfast, overnight stop and then according to above."** Implemented as specified, with a `'midday'` branch inferred by the same split-the-day logic (`day.drive.slot`'s third value, not mentioned in the request) and a `'all-day'`/untagged default for activities selected before this feature existed:
    - `activitySchema` gained an optional `timeOfDay: 'morning' | 'evening' | 'night' | 'all-day'` (`shared/src/schemas.ts`), traveler-set at Select time (`PlaceCard.tsx`'s new time-of-day control, shown only once `status === 'selected'`, only for activities — restaurants already have a fixed `meal`), written via a new `setActivityTimeOfDay` (`src/lib/placeStatus.ts`).
    - New `buildDayRoutePoints` (`src/lib/buildOverviewRoute.ts`) sequences breakfast → morning activity → lunch → evening activity → dinner → night activity → overnight, reordered around `driveSlot`: 'morning' puts breakfast then overnight first: `[breakfast, overnight, morningActivity, lunch, eveningActivity, dinner, nightActivity]`; 'midday' splits the day around the overnight; 'evening' (or no drive at all — a rest day, or the trip's first day) puts the overnight last, since the traveler is already where they are. Falls back to the pre-existing best-rated-activity anchor when nothing is selected yet, exactly matching prior behavior, since there's no meal/time-of-day signal to sequence by before that.
    - `buildOverviewRoutePoints` now calls `buildDayRoutePoints` per day (fixing the restaurant-exclusion bug above as a natural consequence) instead of its own overnight-then-activities logic.
    - The Directions-API route-drawing logic (chunking, straight-line fallback, error banner) was extracted from `OverviewMapScreen.tsx`'s local `TripRoute` into a shared `DirectionsRoute` component (`src/components/DirectionsRoute.tsx`), now used by both screens — `DayViewScreen.tsx` draws its own day route through this same component.
  - Covered by: extended `src/lib/buildOverviewRoute.test.ts` (`buildDayRoutePoints` — meal inclusion, time-of-day slot placement, all three `driveSlot` branches, the no-selection fallback, unusable coordinates; two pre-existing `buildOverviewRoutePoints` tests updated to the new intentional ordering — overnight now sits at the end of a day with selections and no `driveSlot`, not always first); new `e2e/dayview.spec.ts` test for the time-of-day picker end to end (appears only once selected, defaults to all-day, writes the chosen slot to Firestore). **The day-view route line's actual on-screen rendering is not covered by an automated test** — this sandbox has no working `VITE_GOOGLE_MAPS_API_KEY` (network-blocked, same caveat as every other Maps-JS-touching e2e test here), so the Directions/Polyline rendering path never executes in CI; only the pure point-ordering logic feeding it is tested.
  - Also fixed in passing: the overview map's "+ Add stop"/"Rescan this area" buttons (`OverviewMapScreen.tsx`) sat top-left, directly on top of Google's own Satellit/Karta map-type control (also top-left by default) — moved to the top-right.
  - Not done: `TripDay.drive`'s stored distance/duration (and the header's `totalKm`/`avgDriveMinutesPerDay`) still don't account for the extra driving implied by selected activities — that's the separate, already-logged "Selected activities should feed back into route/travel-time awareness" item below, which this doesn't touch (this phase only changed the on-screen route line's shape, not the plan's actual distance/pacing numbers).

- [x] **"I can't see any corridor stop markers" + "Edit route" unreadable in dark mode** (reported 2026-07-30 with a screenshot; fixed 2026-07-30) — two reports, one real bug:
  - **Missing corridor markers: by design, not a bug.** `OverviewMapScreen.tsx` only ever draws a dedicated corridor-stop marker (🔍 proposed / 📌 locked) for stops whose `status !== 'committed'` — every stop a fresh generation produces is `'committed'`, and those deliberately reuse the day's existing overnight badge instead of drawing a duplicate pin at the same coordinates (see phase 3's own note above: "`committed` stops are deliberately NOT re-rendered as a second marker"). Nothing to fix — a traveler only sees a distinct corridor marker after "Rescan this area" (adds `proposed` ones) or "+ Add stop" (adds a `locked` one).
  - **"Edit route" readability: a real bug, confirmed and fixed.** `ReorderCorridorPanel.tsx`'s stop-name rows (`"1. Båstad"`, the "Not yet in the route" entries, and the review step's diff/removed/added lists) carried no text color class at all — not a light-only rule (the pattern this codebase's own design-system comment already warns about), just entirely absent, so it fell back to the browser's default black text against the panel's `dark:bg-neutral-900` background — invisible. Fixed by adding `text-neutral-900 dark:text-white` to each of those three containers, matching the convention already used elsewhere in the same file (e.g. the intro paragraph's `text-neutral-600 dark:text-neutral-300`). Covered by the existing `e2e/corridor.spec.ts` reorder test (asserts on content/behavior, not color, so this class-only fix isn't independently regression-tested — no snapshot/contrast-check tooling exists in this codebase to add one).

- [x] **Day numbering off by one — first day displays as "Day 2"** (bug, reported 2026-07-27; fixed 2026-07-27) — likely root cause found by inspection: every display site assumes 0-based `index` (`day.index + 1` in `DayViewScreen.tsx` and twice in `OverviewMapScreen.tsx`), but nothing enforces that Claude's outline response actually starts numbering at 0 — `routeOutlineDaySchema`/`planTripSkeletonDaySchema` only require `index` to be `nonnegative`, and neither `OUTLINE_SYSTEM_PROMPT` nor `DETAIL_SYSTEM_PROMPT` (`functions/src/prompts/planTripPrompt.ts`) ever states the first day's index must be 0 — an easy ambiguity for the model to resolve the "natural" way (1-based, like a human would number days) instead. Fixed, two parts: (1) `OUTLINE_SYSTEM_PROMPT` now states the 0-based contract explicitly; (2) `parseAndValidateRouteOutline` (`functions/src/prompts/planTrip.ts`) validates indices are exactly `0..days.length-1` with no gaps and retries (same mechanism `callWithRetry` already uses for schema failures) if not. Covered by new tests in `functions/src/prompts/planTrip.test.ts`.

- [x] **Persistent, always-editable route corridor on the Map tab** (requested 2026-07-29; scoped 2026-07-29 — retired the highlights-review pause above once landed) — the highlights-review pause ("Interactive / transparent route planning" above) is a one-shot, ephemeral gate: `RegionHighlightsResponse` lives only in `planMeta.pendingHighlights` while `status === 'awaiting-highlights-review'` and is deleted the instant the traveler submits it — confirmed nothing persists the curated highlights, the route outline, or any backbone/corridor geometry past generation. Separately, every replan path (`runReplan`, and by extension "Request changes" and "Change overnight stop") is destroy-and-regenerate of the whole unlocked remainder via a fresh 3-phase `planTrip()` call — never a diff against what's already there; a locked day is merely protected from deletion, not fed to Claude as a routing constraint, and any freshly-generated day whose date collides with a locked one is silently dropped (`replanTrip.ts`'s own comment admits this limitation).

  The ask: move coarse route planning onto the Map tab permanently instead of a pre-generation gate — always visible, editable at any time including before first generation — with a "rescan this area" affordance that proposes alternatives without disturbing already-committed stops, and a "lock in" step that reconciles the day-by-day plan against the edited corridor (shifting dates for stops that just moved rather than regenerating everything, flagging an end-date extension for explicit accept rather than applying it silently).

  Retires `HighlightsReviewPanel.tsx` and the `awaiting-highlights-review` pause entirely (agreed with the user 2026-07-29) rather than running two competing "review the route" UIs side by side.

  **Scale target, explicitly (2026-07-29):** the motivating trip is roughly a month, Sweden → southern Europe, through several countries on the way — not a 3–7 day trip. This is the deciding factor behind the map-layout correction directly below, and means phase 3/4's per-candidate work (real-detour upgrade, rescan) needs an explicit cap/viewport-scoping story from the start (compute against whatever's currently in view or selected, not "every candidate in the whole corridor" eagerly) — a month-long, multi-country corridor could plausibly hold dozens to low-hundreds of candidate stops, not the handful a 3-day fixture trip exercises in this session's own tests.

  Phased — the largest structural change the app has had, so each phase ships independent value and is a prerequisite for the next rather than one PR:
  1. ~~**Map tab interaction parity** (low risk, no schema change) — port Day View's click-a-pin-highlights-a-card pattern (`selectedPlace`/`MapPanner`/`MarkerBadge`'s `highlighted` prop) onto `OverviewMapScreen.tsx`, which today has no card list and no marker click behavior beyond day badges navigating to Day View. Add `planMeta.status` branching there too — currently the only primary-tab screen with none (`SettingsScreen.tsx` already has this pattern).~~ **Done 2026-07-29**: activity/restaurant markers now set `selectedPlace` (highlighted via `MarkerBadge`'s existing `highlighted` prop, panned-to via a local `MapPanner`, a "Showing: X" caption) — day badges' own click-to-navigate stays unchanged, this only fills the actual gap. `planMeta.status` branching added: `idle` gets a "no plan yet" banner, `pending`/`generating`/`awaiting-highlights-review` a progress banner (reusing the same fields `SettingsScreen` already reads), `error` shows `planMeta.error`; the header stats/"Request changes" row is hidden outside `ready`/`stale`. No card list, no popup — kept today's full-map/zoom-tiered layout as-is per the correction above. Covered by 4 new tests in `e2e/map.spec.ts`; the marker click/highlight itself is unverifiable in this sandbox (Maps JS blocked), same pre-existing limitation as day-badge clicks.
  2. **Persist the corridor**, split in two once scoped further (2026-07-29 — the ID migration turned out to have a much bigger blast radius on the e2e suite than on the app itself, worth shipping and verifying on its own):
     - ~~**2a. Migrate `trips/{id}/days` off date-keyed doc IDs**~~ **Done 2026-07-29**: day docs now use auto-generated Firestore IDs (date stays a field) in all three write paths — `generatePlan.ts`'s `writeGeneratedDays`, `replanTrip.ts`, and `insertRestDay.ts`. The rest of the app was already fully ID-agnostic (`useTripDays.ts` sorts by the `date` field, every screen/hook threads `dayId` through opaquely, `firestore.rules`'s `days/{dayId}` is a plain wildcard) — confirmed by direct read, so no data backfill was needed for existing trips. This is the concrete blocker `insertRestDay.ts`'s own comment named ("no atomic rename") for any future date-shift operation, and paid for itself immediately there: shifting a later day back one calendar day is now a plain field update on its existing doc instead of copying every activity/restaurant subdoc to a new date-keyed parent and deleting the old one. This migration is what makes phase 4 possible at all. The real size of this phase was the e2e suite, not the backend: ~20 `page.goto('/map/day/<hardcoded-date>')` call sites across 5 spec files relied on a day's Firestore ID literally being its date string (the only way to reach Day View directly, since Google Maps JS is network-blocked in this sandbox and day-badge clicks have never been testable here) — all switched to a new `getDayIdByDate(tripId, date)` e2e helper. Covered by the existing `functions/src/generatePlan.writeGeneratedDays.test.ts`/`insertRestDay.test.ts`/`replanTrip.test.ts` (updated, not new coverage) and the full e2e suite.
     - ~~**2b. New `corridorStops` collection**~~ **Done 2026-07-29**: `trips/{id}/corridorStops/{stopId}` (schema in `shared/src/schemas.ts` — a first-class client-read collection, unlike the internal `pendingHighlights` shape it deliberately doesn't reuse), auto-generated IDs, `status: proposed|committed|locked` and `linkedDayIds: string[]`. Rather than trying to persist Claude's pre-selection highlight candidates (no stable identity — addressed purely positionally, confirmed via `HighlightsReviewPanel.tsx`, and don't reliably map 1:1 to the days a generation finally produces), stops are derived from the *actual generated days'* `overnight` stops — the real, fully-resolved route backbone — via a new `buildCorridorStopWrites` helper (`functions/src/corridorStops.ts`) that groups consecutive same-overnight days (e.g. rest days) into one stop. Every stop this phase writes is `'committed'`; `'proposed'`/`'locked'` stay unused until phase 3. Wired into all three write paths: `generatePlan.ts`'s `writeGeneratedDays` (wipes+rewrites corridor stops alongside days, same as it already does for activities/restaurants), `replanTrip.ts` (deletes only stops overlapping the regenerated future-day range, leaves past/locked ones untouched; also switched this function from a raw `db.batch()` to `commitInChunks` while touching this exact write path, since the added writes push it closer to the 500-op cap on a long trip), and `insertRestDay.ts` (the inserted rest day shares its source day's overnight, so it's appended to that day's existing corridor stop's `linkedDayIds`; silently skipped for trips with no corridor data yet). `firestore.rules` gained a flat `corridorStops/{stopId}` rule matching the existing `countries`/`log` pattern. Covered by a new `functions/src/corridorStops.test.ts` plus updates to `generatePlan.writeGeneratedDays.test.ts`, `replanTrip.test.ts`, `insertRestDay.test.ts`, and `firestore-rules.test.ts`. Backend-only — no UI reads this collection yet; that's phase 3.
  3. ~~**Corridor editing + "rescan an area"**~~ **Done 2026-07-29**: the corridor is now a live map layer on `OverviewMapScreen.tsx`, rendered as its own marker tier within the *existing* zoom-tiered progressive disclosure (`mapZoomTiers.ts`'s new `showCorridorStops`, same `>=6` tier as overnight stops) — no card list, no separate screen, per the layout correction. Only `proposed`/`locked` stops get their own marker (🔍/📌 via new `CORRIDOR_PROPOSED_ICON`/`CORRIDOR_LOCKED_ICON`) — `committed` stops are deliberately NOT re-rendered as a second marker, since they'd exactly duplicate the existing day badge at the same coordinates (`buildCorridorStopWrites` derives them 1:1 from `TripDay.overnight`); locking/removing a `committed` stop is a phase-4 reconciliation concern, not this layer's. Tapping a stop opens `CorridorStopCard` (the "lightweight, non-modal tap-to-reveal" surface, anchored top-right, not `HighlightsReviewPanel`'s list chrome) with Lock/Unlock/Remove, wired to two new plain Firestore-write functions in `src/lib/corridorStopActions.ts` (`setCorridorStopStatus`, `deleteCorridorStop` — same philosophy as `markSelected`). `AddCorridorStopForm.tsx` (mirrors `AddCustomStopForm.tsx`) lets a traveler pin a stop directly, writing `status: 'locked'` immediately (a deliberate action, same reasoning as custom activities writing `status: 'selected'` outright) with empty `linkedDayIds` — reconciling it into a real day is phase 4's job. `corridorStopSchema` loosened accordingly: `country` is now optional (Places autocomplete alone doesn't resolve one) and `linkedDayIds` may be empty. Rescan (`RescanCorridorButton.tsx` → new `rescanCorridor` callable) searches a fixed 25 km radius around the map's current center (tracked via `onCameraChanged`), modeled on `enrichHighlights.ts`'s retry/parse/geocode loop but radius-filtered via `haversineDistanceKm` instead of route-detour, capped at `MAX_RESCAN_RADIUS_KM` (50 km, server-enforced) and `MAX_RESCAN_RESULTS` (10) — writes only `proposed` stops, structurally incapable of touching `committed`/`locked` ones, so no merge algorithm was needed. No busy-guard/cost-guard machinery: rescan never touches `planMeta.status` or the days collection, so concurrent rescans are merely redundant, not corrupting. Covered by `functions/src/prompts/rescanCorridor.test.ts` (10 tests), `functions/src/rescanCorridorCallable.test.ts` (4 tests), updated `mapZoomTiers.test.ts`, and 3 new `e2e/corridor.spec.ts` tests (add-stop write, validation, and rescan's credential-less degradation to an error banner — marker-click interaction itself stays unverifiable in this sandbox, same pre-existing Maps-JS-blocked limitation as every other marker).

     **CI fix (found + fixed 2026-07-29, while checking CI on the phase 4a push):** `AddCorridorStopForm`/`RescanCorridorButton` were wrapped in `{apiKey && (...)}` on `OverviewMapScreen.tsx` — but this repo's CI build/test job deliberately never sets `VITE_GOOGLE_MAPS_API_KEY` (matching this sandbox's own Maps-JS-blocked reality, same as every other screen's fallback-input pattern), so that gate silently hid both from the very first CI run after this phase landed — 3 of `corridor.spec.ts`'s 4 tests had been failing in CI (all 3 retries) since this phase's own commit, unnoticed locally because this session's own `.env` happens to carry a real Maps key. Neither component is actually a `GoogleMap` child or needs the Maps JS SDK to render — only `center` state does, which is already sourced from `trip.settings.startPoint` independent of `apiKey` — so the gate was dropped entirely. Confirmed by temporarily stripping `VITE_GOOGLE_MAPS_API_KEY` from a local `.env` (matching CI's own) and re-running `corridor.spec.ts` (4/4 pass) plus the full suite (no new failures beyond the pre-existing, already-documented "Execution context was destroyed" navigation flakiness, reconfirmed passing standalone).
  4. **"Lock in the new route"** — the reconciliation engine, split in two (mirroring how the highlights-review pause itself was deliberately scoped down to a v1 the first time):
     - ~~**4a. Reorder/date-shift only**~~ **Done 2026-07-29**: new `functions/src/corridorReconciliation.ts` (`computeCorridorReconciliation`/`runReconcileCorridor`). Found before writing any code, not assumed: nothing in phases 1-3 gave a traveler any way to actually *trigger* a reorder — `corridorStops` carries no order/sequence field, and phase 3 deliberately gives `committed` stops no marker of their own. Resolved by deriving each committed stop's current order from its linked days' own `.index` (already a valid, real ordering key — no new read-side field needed) and adding a plain up/down-button list, `ReorderCorridorPanel.tsx` — no drag-and-drop, the same lesson `HighlightsReviewPanel`'s own re-ranking already learned the hard way (its e2e suite explicitly asserts no `[draggable]` affordance survives; native HTML5 drag-and-drop never worked reliably on a touch device). A stop can cover more than one `TripDay` (a rest day shares its previous day's overnight) — those move as one block, keeping their internal order, onto the trip's own existing date sequence (reordering only permutes which content sits on which date, it never changes trip length); only a block's first day ever gets a recomputed drive leg (via the existing `computeRouteLeg`), later days in the block (e.g. the rest day) keep their content untouched apart from date/index. Reviewed via a diff before anything writes: "Preview changes" calls a new `previewReconcileCorridor` callable (read-only, no busy guard needed — nothing is written) that runs the exact same computation and returns a `ReconcileDayChange[]` diff (new schema in `shared/src/schemas.ts`); "Confirm" submits through the normal `planRequests` flow with a new `reconcileCorridor` request kind, reusing `generatePlan.ts`'s existing one-operation-per-trip busy guard (unlike phase 3's rescan, this mutates real day data) — then closes and relies on the existing `planMeta.status === 'generating'` banner for the wait, same philosophy as `AddRestDay.tsx`. `computeCorridorReconciliation` rejects anything but a pure permutation of the current committed-stop set — adding/removing a stop is phase 4b's job, not this one's. Also fixed along the way: `e2e/helpers/seedFixturePlan.ts` never materialized `corridorStops` at all (it bypasses `buildCorridorStopWrites` by writing days directly), and never set a real `settings.startPoint`/`endPoint` (defaulting to `{lat:0,lng:0}`) — both silently correct for every prior phase's tests but a real gap once a feature (this one) needs to compute a real leg back to the trip's own start; fixed by mirroring the stop-grouping logic inline and seeding Oslo/Otta as the fixture's start/end points. Covered by `functions/src/corridorReconciliation.test.ts` (11 tests: remapping, no-op reorder, permutation rejection, multi-day blocks, pacing-failure rollback, and the full trigger dispatch including its own busy-guard test), `functions/src/previewReconcileCorridorCallable.test.ts`, and a new `e2e/corridor.spec.ts` reorder test exercising the real UI end to end (preview → diff → confirm → committed swap).
     - ~~**4b. Add/remove-stop + end-date extension**~~ **Done 2026-07-29**: generalized 4a's `computeCorridorReconciliation` from a pure permutation to a `newStopOrder` that may also omit a currently-committed stop (removing it — its linked day(s), and their activities/restaurants subcollections, are deleted outright; the corridor stop doc itself is deleted too; a hard integrity check rejects the whole request if some existing day would be left belonging to no committed stop) or include a currently-`locked` stop with no linked days yet (adding it — a traveler-placed pin or a locked rescan find). An added stop's content is generated via just the detail phase (`generateChunkDetail`, factored out of `planTrip.ts`'s chunk loop so both share the same prompt-building/retry/cache logic) — the outline/curation phases are skipped entirely since the town/location/why is already known from the corridor edit. The generated day is resolved through the SAME `resolveSkeletonDay` fresh generation and replan use (not a hand-rolled shortcut — this is what keeps the evening-slot activity-anchor logic correct, per this file's own earlier correctness-contract note), extended with an optional `knownOvernight` parameter so it uses the stop's own already-resolved coordinates instead of re-geocoding by name (which could silently resolve to a different point than the one the traveler actually placed). A locked stop with no `country` (every stop added via `AddCorridorStopForm` today, since Places Autocomplete alone doesn't resolve one) is rejected with a clear, actionable error rather than guessing one — a known v1 gap, not a silent failure. Because add/remove changes the day count, the reused-date-sequence shortcut 4a relied on no longer applies: dates are recomputed fresh as `settings.startDate + i` for the final sequence length, and whenever that implies a different `settings.endDate` than the trip currently has, `runReconcileCorridor` refuses to write anything unless the caller explicitly passes `acceptEndDateChange: true` — an edit meant as "swap this stop for that one" must never silently move the trip's return date. `ReorderCorridorPanel.tsx` (kept its name/testid despite the broader scope, to avoid churn) extended with a "✕ remove" button per row (disabled on the last remaining stop) and a "Not yet in the route" section listing addable locked stops with a "+ Add" button; the review step shows removed-stop names, added-day names/dates, and — when present — an amber `endDateChange` notice with a checkbox that must be ticked before "Confirm" enables. Covered by 7 new `functions/src/corridorReconciliation.test.ts` cases (unknown/duplicate stop id, removal + subcollection cleanup + orphan-day integrity check, adding a locked stop end-to-end with mocked Claude/Places, missing-country rejection, proposed-stop rejection, end-date guard) and 2 new `e2e/corridor.spec.ts` tests (removing a stop through the real UI including the end-date-accept gate; adding a locked stop degrading to an error banner, same credential-less-sandbox pattern as rescan). Also fixed along the way: neither `functions/src/corridorReconciliation.test.ts`'s fixture helper nor `e2e/helpers/seedFixturePlan.ts` set `settings.startDate`/`endDate` to match their own seeded days' dates (a bare `createTrip` defaults `startDate` to "today") — silently correct for 4a's reorder-only case (which reused the existing date sequence verbatim) but a real gap now that reconciliation always recomputes dates from `settings.startDate`; fixed by setting both explicitly in every fixture.

  5. ~~**Retire `HighlightsReviewPanel.tsx` and the `awaiting-highlights-review` pause**~~ **Done 2026-07-29**: now that the reconciliation engine (4a+4b) gives the corridor a persistent, always-editable equivalent, the ephemeral one-shot pause was removed entirely rather than left running alongside it. Deleted outright: `src/components/HighlightsReviewPanel.tsx`, `src/lib/estimateHighlightsRoute.ts` (+ its test — detour-math helpers only that panel used), `functions/src/prompts/enrichHighlights.ts`/`enrichHighlightsPrompt.ts` (+ test — the opt-in web-search-for-more-stops pass only made sense paired with a review step to judge its finds against, per its own Settings-screen comment; phase 3's "rescan this area" is the persistent-corridor equivalent), `functions/src/generatePlan.enrichHighlights.test.ts`, `functions/src/generatePlan.reviewPause.test.ts`, and `e2e/highlights-review.spec.ts`. Trimmed from `shared/src/schemas.ts`: `'awaiting-highlights-review'` off `planStatusSchema`, `'continueFromHighlights'` off `planRequestSchema.kind`, and the `reviewHighlights`/`searchForMoreStops`/`editedHighlights`/`reviewNote`/`planMeta.pendingHighlights` fields entirely. `generatePlan.ts` lost the whole review-pause branch, `pauseForHighlightsReview`, `withWebSearchFinds`, the busy-guard's `isPausedForReview` carve-out (a `'continueFromHighlights'` request no longer exists to need one), and `generateRealPlan`'s `SkeletonSource` parameter (always fresh now — the only other source, `'fromHighlights'`, only existed to resume a review). `SettingsScreen.tsx` lost both checkboxes and the panel render; `OverviewMapScreen.tsx`'s status banner branching dropped the now-nonexistent status. `planTrip.ts`'s own `generateRegionHighlights`/`generateSkeletonFromHighlights` split was deliberately left alone — `planTrip()` itself still calls both in sequence unconditionally, so the split remains a harmless, still-correct internal shape with no UI dependency on it anymore, not worth re-collapsing for this cleanup. Verified via full `tsc -b --force` (catches cross-package dangling imports project-reference builds can otherwise cache past), lint, both build outputs, `npm run test`/`test -w shared` (28+32 passing), `npm run test:functions` (144 passing, down from 165 by exactly the 21 tests the 3 deleted functions-test files carried), and the full `npx playwright test` suite.

  Cross-cutting: simple corridor edits (phase 3) are direct Firestore writes and never touch the existing trip-global `planMeta.status` busy-guard; only rescan and reconcile (Claude/Places/Routes calls) need it, extending the existing claim-transaction pattern in `generatePlan.ts` with `rescanning`/`reconciling` states rather than inventing new locking.

  Explicitly out of scope for the whole roadmap: cross-region corridor reflow (moving a stop far enough that the *whole* trip needs re-sequencing) — the reconciliation algorithm should detect this case and fall back to a full replan of the affected region rather than forcing it through the shift/insert/delete primitives above.

  **Carry forward from this session's HighlightsReviewPanel/DayView/overnight-candidates work (2026-07-28/29) rather than re-deriving any of this from scratch** — every one of these was learned the hard way (a real bug, a real "doesn't work on phone" report) on data shaped almost exactly like a corridor's:
  - **Keep today's `OverviewMapScreen` layout as the base — full-screen map, zoom-tiered progressive disclosure — don't carry over `HighlightsReviewPanel`'s sticky-map/scroll-list chrome (correction, 2026-07-29).** The user specifically likes today's map layout and wants it adapted, not replaced, and that's the right call at the stated scale (a month, several countries): a flat scrolling list of a month's worth of corridor stops is exactly the kind of UI that stops working, whereas zoom-based progressive disclosure (already built — day badges at low zoom, activities/restaurants revealed at higher zoom) is designed for precisely this and just needs a corridor-stop tier added to it. What DOES carry over from `HighlightsReviewPanel` is the *functionality*, presented through a lightweight, non-modal tap-to-reveal (reuse phase 1's click-a-pin interaction, or a small inline card anchored to the tapped marker) instead of a persistent list: the priority tiers with up/down promote/demote, the live/dynamic route recalculation as the corridor changes (`BackboneRoute`'s real-Directions-on-edit behavior — literally "the routing is always present" from the request), and the per-stop detour figures below. (Also worth noting: the "too big for phone" `InfoWindow` popup mistake that motivated `HighlightsReviewPanel`'s sticky-list redesign in the first place is exactly the failure mode a *reused* full-detail-in-a-popover affordance would risk repeating here — keep whatever per-marker detail surface phase 3 builds deliberately small/compact, not a copy of the full candidate-detail card.)
  - **Editable items need a stable ID, not a position, or "which one is selected" silently rots.** Positional (region-index/stop-index) identity in the current `HighlightsReviewPanel`/`RegionHighlightCandidate` shape was a repeat source of bugs this session — a removal shifting indices out from under a still-open selection, requiring an unconditional `setSelectedStop(null)` on every removal as a blunt workaround, since there was no ID to check "is my selection still valid" against. Reinforces phase 2's stable-ID decision for `corridorStops`: whatever tracks "which stop is currently focused/being edited" on the corridor map needs to key off the real Firestore ID, not an array position, from day one.
  - **Dropping the last item from a group should drop the group, not leave an empty shell.** `updateRegionStops` in `HighlightsReviewPanel.tsx` filters out any region left with zero `candidateStops` after an edit — the server schema requires ≥1 stop per region and a stale empty group is also just useless UI. Corridor regions (or however phase 3 buckets rescanned stops) need the identical rule: removing/skipping the last stop in an area drops that area.
  - **Reversible "skip" is a local hide-behind-a-toggle, not silent deletion and not a status nobody can see.** Built twice this session for genuinely ephemeral/re-fetchable data (`DayViewScreen.tsx`'s `PlaceCardSection` for suggested activities/restaurants; `OvernightCandidatesPicker.tsx` for overnight candidates): skipped items drop out of the main view (clearing room for the next option) but collect behind a "Show N skipped" toggle so the action is reversible, not destructive. `proposed` corridor stops a traveler dismisses during a rescan review are the same shape of problem — reuse this exact pattern rather than a modal confirm or a hard delete.
  - **One shared `FitToPoints` (`src/components/FitToPoints.tsx`), not a per-screen reimplementation.** Extracted this session because `HighlightsReviewPanel` and `DayViewScreen` had each grown their own copy; also fixed a real bug where `DayViewScreen`'s map froze on a stale focused pin after Prev/Next because nothing re-fit the view or reset `selectedPlace` when the underlying day changed (React Router reuses the component instance across `/map/day/:dayId` param changes — it never remounts). The corridor screen persisting across `idle → generating → ready` transitions on one long-lived `/map` route is the exact same shape of risk: whatever holds "what's currently focused" must reset via the render-time-adjust-state-on-prop-change pattern (not a `useEffect`, to satisfy this repo's `react-hooks/set-state-in-effect` lint rule) whenever the corridor's own identity/version changes, or it'll go stale the same way.
  - **Detour math: haversine estimate first, upgrade to a real Directions figure per candidate against whichever backbone leg the estimate already picked, and label which is which.** `findCheapestBackboneLeg` (`shared/src/geo.ts`) guarantees the instant estimate and the later real lookup agree on which leg to measure; the UI shows `≈+N km` until the real figure lands, then drops the `≈`. Reuse directly for corridor detour figures rather than inventing a second detour UI language — a traveler comparing "keep vs. rescan-replace" needs the same honesty about estimate-vs-confirmed.
  - **Degrade each independent data source on its own, never let one take the others down.** `fetchOvernightCandidates` used to fail its *entire* result via one `Promise.all` if just one of three independent lookups (Places/Overpass/Claude) errored — Overpass in particular has no SLA. Fixed with a `safe()` wrapper per source, log-and-return-`[]` on failure. Phase 3's rescan combines multiple sources the same way `enrichHighlights.ts` already does (curated + web-search); wrap each independently rather than risking a repeat of "the whole rescan failed" when only one source hiccuped.
  - **Real map errors need a UI banner, not console-only logging.** `BackboneRoute`'s `describeDirectionsError` + a `routeError` banner exist because a failed/misconfigured Directions call is undiagnosable on a phone with no devtools attached. Whatever route-rendering component phase 3/4 ends up with (likely a consolidation of `BackboneRoute` and `OverviewMapScreen`'s parallel, independently-written `TripRoute` — both already do the same "chunked sequential Directions calls, polyline fallback" thing) needs to keep this, not regress to silent failure.
  - **Compact, truncated marker labels once a map is carrying real density.** Full-name pills work for 2-3 start/finish markers; once there are many candidate stops on screen (exactly the corridor's use case), `CandidateMarker`'s truncated/smaller label (`max-w-20`, `text-[10px]`, full name still on hover title and in the linked list row) is the pattern to reuse rather than relearning "long labels crowd the map" again.
  - **The evening-slot geocoding-anchor fix in `resolveSkeletonDay` (`functions/src/planPipeline.ts`) is a correctness contract, not just a bugfix — phase 4b's "generate only the new day(s) via just the detail phase" must call through this same resolver, not a hand-rolled shortcut,** or it'll silently regress to searching a newly-inserted day's activities near the wrong town again (it was anchoring at the day's *destination* regardless of drive slot, contradicting `OUTLINE_SYSTEM_PROMPT`'s own documented "drive after that day's activities and dinner" default).

- [x] **Prompt caching (`cache_control`) for the Claude calls in `functions/src/prompts/*.ts`** (requested 2026-07-29 — the Anthropic Console's Caching dashboard showed no cached traffic; done 2026-07-29) — investigated every `client.messages.create` call site (`planTrip.ts`, `enrichHighlights.ts`, `rescanCorridor.ts`, `overnightCandidates.ts`, `countryGuide.ts`) before adding anything: Claude Sonnet 5's minimum cacheable prefix is 1024 tokens, and every one of this codebase's hand-written system prompts is individually well under that (≈480–910 tokens by rough char-count), so a `cache_control` marker on just `system` would silently create zero cache entries (`cache_creation_input_tokens: 0`) on almost every call here — cargo-culting the marker everywhere would look like "implemented" while doing nothing. Also ruled out caching the retry path (`MAX_ATTEMPTS = 2`) for every single-shot call (highlights, outline, enrichHighlights, rescanCorridor, overnightCandidates, countryGuide): each is one call per trip with request-specific content (different settings/notes every time) and no other call shares its exact prefix within the 5-minute TTL, so a breakpoint there pays the ~1.25x cache-write premium for a second read that essentially never happens (only fires on the rare schema-validation retry) — net negative expected value, not caching.

  The one real win: `generateSkeletonFromHighlights`'s chunked detail-generation loop in `planTrip.ts` (`CHUNK_SIZE = 7` days per call) calls Claude once per chunk of a *single* trip, and every one of those calls repeats the exact same `settings`/`notesFreeText`/`fullRouteOutline` JSON — only `daysNeedingDetail` (the chunk itself) differs. That's the textbook "shared prefix, varying suffix" shape, and for any trip longer than `CHUNK_SIZE` days (this session's own stated month-long, multi-country scale target guarantees several chunks), the shared prefix is both large and guaranteed to repeat within the same generation run, well inside the 5-minute TTL. Implemented: `buildChunkDetailPrompt` (`planTripPrompt.ts`) now returns `stableUser` (settings/notes/fullRouteOutline) and `variableUser` (daysNeedingDetail) separately instead of one merged string; `callWithRetry` (`planTrip.ts`) was widened to accept content blocks instead of only a plain string, and the chunk loop puts `cache_control: {type: 'ephemeral'}` on the `stableUser` block — but only when `chunks.length > 1`, since a single-chunk (short) trip has no second call to read the cache back and would just pay the write premium for zero reads. The breakpoint sits after `system` in render order, so it caches `DETAIL_SYSTEM_PROMPT` + the stable JSON as one unit per the "put the breakpoint at the end of the shared portion" pattern — no separate marker needed on `system` itself. Covered by two new assertions in `functions/src/prompts/planTrip.test.ts`: a single-chunk trip gets no `cache_control` at all, and a 10-day (2-chunk) trip gets a matching `cache_control` marker on both chunk calls with byte-identical stable-block text and differing variable-block text.

- [x] **Root-caused and fixed the recurring e2e flakiness ("Execution context was destroyed, most likely because of a navigation")** (requested 2026-07-30 — "do a pass on all your known 'flaky' tests to make them more robust"; root cause found and fixed same day) — this had been showing up on random spec files on nearly every full-suite run all session, always on a `page.evaluate()` immediately after a `waitFor()`, always confirmed non-regressive by an isolated rerun, and until now always written off as unexplained sandbox contention. Investigated properly this time instead of continuing to shrug it off:
  - **Root cause: `src/main.tsx`'s service-worker `controllerchange` reload fired on every first-ever page load, not just a genuine cross-deploy update.** `clientsClaim()` (from `vite.config.ts`'s `registerType: 'autoUpdate'`) fires `controllerchange` the very first time an *uncontrolled* page gets claimed too — not only when an existing controller is replaced by a newer one. Every Playwright test starts a fresh `BrowserContext` with no prior SW controller, so every single test triggered one unconditional full reload sometime after `goto('/')`. On an idle machine the reload finished before the test's own `waitFor()` even resolved, so it was invisible; under this sandbox's 2-core contention, the reload's timing drifted into the exact gap between `waitFor()` resolving and the next `evaluate()` running — `page.evaluate()`, unlike Playwright's locator actions, doesn't retry across a navigation and throws "Execution context was destroyed" instead. This is also a **real user-facing bug**, not just a test artifact: every visitor's first-ever load of the app was silently reloading itself once, for no reason.
  - **Fix**: guard the listener registration on `navigator.serviceWorker.controller` already being non-null at load time — only a page that was already controlled by an older worker should reload on the next `controllerchange`; a page's first-ever claim should not. Verified as the actual cause, not just a plausible one: temporarily reverted the guard and confirmed `e2e/service-worker.spec.ts`'s new regression test fails (`loadCount: 2`) without it, then re-confirmed it passes with the fix restored.
  - **New regression test** (`e2e/service-worker.spec.ts`): tracks `page.on('load')` count across a fresh visit, waits for `navigator.serviceWorker.controller` to actually become non-null (proving `controllerchange` really fired, not just that the timing window was missed), and asserts the load count never left 1.
  - **Defense in depth on the test side too**, per the request to harden the tests themselves, not only the app: new `evaluateWithRetry` helper (`e2e/helpers/seedFixturePlan.ts`) retries a `page.evaluate()` call a few times on any thrown error rather than failing outright — covers any other incidental navigation under contention, not just this one now-fixed source. Applied to every vulnerable `page.evaluate()` immediately following a `goto`/`waitFor`/`click` across `seedFixturePlan.ts`'s `createTripWithPlan` (the dominant call site — used by ~40 tests across 9 spec files) and the inline copies of the same pattern in `cost-guards.spec.ts`, `diary.spec.ts`, `map.spec.ts`, `execution-mode.spec.ts`, `sync.spec.ts`, `responsive-offline.spec.ts`, and `trip-management.spec.ts`. Left untouched: call sites already wrapped in `expect.poll` (already retry-tolerant) and locator-scoped `locator.evaluate(...)` calls (already navigation-resilient).
  - **Verification**: 3 consecutive full `npx playwright test` runs, 58/58 passing every time with zero failures — the first time this session a full-suite run has been completely clean (every prior run had 2-8 failures matching this exact signature).

- [x] **Claude API cost investigation + fixes** (requested 2026-07-30 — "$20 of Claude API from limited testing, can usage be investigated/logged?" plus a screenshot-driven hypothesis that trip setup's free-text notes field was a major cost driver; investigated and fixed 2026-07-30) — investigated before changing anything, since the user's own hypothesis needed testing rather than assuming:
  - **Notes-field hypothesis: tested and disproved.** Measured the free-text notes field's actual share of a generation's input payload directly — ≈0.06% of one generation's total cost, not worth optimizing. The real cost shape: output tokens dominate (Sonnet 5 output is priced 5x input, and detail-phase responses — 5 activities + 9 restaurants per day, per `DETAIL_SYSTEM_PROMPT` — are the largest outputs this app produces), so call *volume* × output size is what actually drives spend, not any one input field. $20 from "limited testing" lines up with roughly 70 full generations at this app's own per-generation cost, consistent with iterating on settings/retries during manual testing rather than any inefficiency in a single call.
  - **Fixed: uncapped `web_search` on 3 of the 6 Claude call sites.** `overnightCandidates.ts`, `rescanCorridor.ts`, and `countryGuide.ts` all declared the `web_search_20260209` tool with no `max_uses`, meaning both the per-search fee and the (larger, invisible) injected-search-result input tokens were unbounded per call — a single lookup could search far more than it ever needed to. Capped at `max_uses: 3` for the two single-topic lookups (overnight-stop and rescan) and `max_uses: 8` for the country guide (6 topics, some needing more than one search each). No behavior change to what these calls can return, just a ceiling on how much searching one call can rack up.
  - **Added: structured Claude usage logging**, the thing actually asked for. Every one of the 6 Claude call sites (`highlights`, `outline`, `detail`, `reconcileDetail`, `rescan`, `overnight`, `countryGuide`) now logs one structured JSON line per API call via a new `logClaudeUsage` helper (`functions/src/claudeUsageLogger.ts`): `callType`, `tripId` (threaded through as a new optional field on every affected function's input, from wherever it was already in scope at the call site — `tripRef.id` in `generatePlan.ts`, the existing `tripId` param in `replanTrip.ts`/`corridorReconciliation.ts`/the three callables), `model`, `attempt`, and the response's `input_tokens`/`output_tokens`/`cache_creation_input_tokens`/`cache_read_input_tokens`/`server_tool_use.web_search_requests`. Plain `console.log(JSON.stringify(...))`, not a Firestore collection — Cloud Functions already ships stdout to Cloud Logging for free, queryable by `jsonPayload.callType`/`jsonPayload.tripId` with zero marginal cost or new UI; a Firestore-backed version would only be worth building later for an in-app "this trip cost $X" feature, which wasn't asked for here. `logClaudeUsage` degrades to zeros rather than throwing if `response.usage` is ever missing (best-effort observability should never be able to take down a real generation over a logging gap).
  - **Investigated but explicitly not built without a product decision**: this also surfaced that `DETAIL_SYSTEM_PROMPT`'s hard-coded "exactly 5 activities and exactly 9 restaurants per day" is the single biggest available cost lever (≈20% of one generation's cost) — not touched, since shrinking it is a product/UX tradeoff (fewer options per day), not a pure efficiency fix. Also surfaced as backlog, not built: country guides are cached per-trip rather than globally by country code (redundant regeneration across multiple test trips through the same country), and the overnight-candidates picker's Claude+web_search calls aren't memoized (fires fresh every time "Change overnight" opens, even for the same day). Both are real, scoped wins, held for an explicit go-ahead rather than bundled in here.
  - **Separately investigated, not implemented**: whether real (non-anonymous) login would let trip-sharing be retired, per the same request's second question. Conclusion: no — they solve different problems (login = one person's persistent/cross-device identity; sharing = multiple people on one trip). Firebase's anonymous-to-Google-account linking (`linkWithPopup`/`linkWithCredential`) would preserve the existing uid with zero data migration and no `firestore.rules` changes (this app's rules are pure uid comparisons), making it a low-risk optional add whenever wanted — but it wouldn't remove the need for share codes, and invite-by-email would need strictly more infrastructure (email→uid resolution, pending-invite claims, real email delivery) than what exists today. Recommendation given, not acted on — no "build it" decision made yet.
  - Covered by `functions/src/claudeUsageLogger.test.ts` (structured log shape, graceful degradation on missing `usage`); existing `functions/src/prompts/*.test.ts` and `functions/src/rescanCorridorCallable.test.ts` extended/updated for the `tripId` threading and `max_uses` additions. Full `npm run test:functions` (159 tests), `npx tsc --noEmit`, and `npm run lint` all clean.

- [x] **Optional Google account linking, for backup/recovery** (recommended during the cost-investigation entry above, "go ahead" given 2026-07-30, implemented same day) — every identity in this app has been anonymous Firebase Auth (`ensureSignedIn` → `signInAnonymously`) since the start: clearing browser storage, or moving to a new device, permanently loses access to every trip that device's anonymous uid was a member of, with a trip's own share code as the only (per-trip, not account-wide) recovery path. This adds an opt-in way to not lose that.
  - **Preserves the anonymous uid — no data migration, no `firestore.rules` change.** `linkGoogleAccount` (`src/lib/accountBackup.ts`) calls `linkWithPopup(auth.currentUser, new GoogleAuthProvider())`, which upgrades the existing anonymous user in place rather than creating a new one — every `trips/{tripId}/members/{uid}` and `users/{uid}/trips/{tripId}` doc this app already writes stays valid untouched, and since every rule in `firestore.rules` is already a pure uid comparison (`isMember`), nothing there needed to change either.
  - **The one real wrinkle, handled rather than left as a dead end: `auth/credential-already-in-use`.** This fires when the Google account being linked is already linked to a *different* Firebase user — the expected case the second time a traveler backs up a second device with the same Google account (device A already claimed that Google credential; device B's own anonymous uid can't also claim it). Firebase's own recovery path for this is to sign into the existing account instead — which abandons device B's local anonymous uid and, with it, whatever trips it already owned. Handled by capturing device B's anonymous ID token before the switch, then calling a new `mergeTrips` callable (`functions/src/mergeTrips.ts`) once signed into the surviving account, which walks `users/{oldUid}/trips` and adds the surviving uid as a member of every one of them (`trips/{tripId}/members/{newUid}` + the reverse index), so device B's own trips aren't silently lost, just as reachable as its Google-backed sibling's already were. Verified server-side via `getAuth().verifyIdToken(oldIdToken)` before trusting anything — a bare `oldUid` string alone would let any caller graft themselves onto another traveler's trips just by guessing/knowing a uid; the old account's own valid ID token is what actually proves the caller controlled it.
  - **UI**: new `AccountBackupMenu` (`src/components/AccountBackupMenu.tsx`), same collapsed non-modal `<details>` pattern as `ShareTripMenu`, placed right next to it on Trip setup (`SetupScreen.tsx`). Shows "Back up with Google" when unlinked, the linked email once it isn't. After a merge (the uid actually changed), `window.location.reload()` — every hook this app keys on uid (`useTripSession`, `useMyTrips`) would otherwise stay stale, same tradeoff already made for a deployed service-worker update (`main.tsx`'s own `controllerchange` reload).
  - **Investigated but deliberately not built**: retiring trip-sharing's share codes in favor of login — concluded no, they solve different problems (login = one person's persistent/cross-device identity; sharing = multiple people on one trip; see the cost-investigation entry above for the full reasoning). Invite-by-email was ruled out for the same reason there — strictly more infrastructure than this app has today. Also not built: a redirect-based fallback for `linkWithPopup` (relevant if a PWA/mobile browser blocks the popup) — kept to the simpler popup-only flow per this session's "start simple" default; a real popup-blocking report would be the trigger to add it, not speculation now.
  - **Requires one manual, one-time console step this session cannot perform**: the Google sign-in provider must be enabled for this Firebase project (Authentication → Sign-in method → Google, in the Firebase console) before this works against production — the Auth Emulator simulates every provider regardless of console config, which is why it works in tests/dev without this step already being done.
  - Covered by `functions/src/mergeTrips.test.ts` (real ID tokens minted via the Auth Emulator's own REST API, not stubbed — merges every trip across, rejects a token that doesn't match the claimed `oldUid`, no-ops when there's nothing to merge or the uids are already the same) and a light `e2e/sharing.spec.ts` smoke test (the menu renders and offers the link button to an unlinked session). **The actual Google OAuth popup flow itself is not covered by an automated test** — same limitation as every other real-credential-gated flow in this app's e2e suite (Maps JS, iOS Safari keyboard behavior): this sandbox has no real Google account to drive `linkWithPopup` against.

- [x] **Explore mode: repeatable, cheap, jointly-editable stop curation before committing to a full plan** (requested 2026-07-30 — "I want to play around in this mode for quite a while... not accidentally lock in a plan ahead of time... additional confirmation needed before we commit, as this will trigger immense spending"; scoped via two AskUserQuestion decisions, then built same day) — the old highlights-review pause (see "Interactive/transparent route planning" above) was retired 2026-07-29 in favor of post-generation corridor editing, which left no way to see or iterate on just the main stops without first paying for a full day-by-day generation (5 activities + 9 restaurants per day, the dominant cost per the cost-investigation entry above). This rebuilds that step as something genuinely revisitable instead of a one-shot pause, and adds the requested confirmation gate in front of every full-generation trigger, not just this new one.
  - **Data model** (chosen over a separate collection, AskUserQuestion): `corridorStops` gained a fifth status, `candidate`, plus `priority` (`must-see`/`worth-a-detour`/`nice-if-convenient`, Claude's own call), `region` (source region label, for grouping), and `rank` (position within its own priority tier, swapped pairwise by up/down votes — tiers are compared independently, matching the old panel's "re-ranked priority tiers" behavior). Reuses every bit of existing corridor machinery (map markers, rescan, add-stop form, firestore.rules) instead of duplicating it.
  - **Placement** (chosen over a new nav tab, AskUserQuestion): the Map tab's old plain "No plan yet" banner is now a full screen (`ExploreMapScreen.tsx`) whenever `planMeta.status === 'idle'` — `OverviewMapScreen.tsx` early-returns into it after all its own hooks have already run (kept hooks unconditional, only the returned JSX branches, so this doesn't violate rules of hooks).
  - **Cheap, repeatable curation**: a new `generateExploreHighlights` callable runs *only* `generateRegionHighlights` (phase 1 — no per-day detail, no chunked outline/detail calls) and writes the results as `candidate` stops, replacing any previous candidates but never touching `locked` ones (the traveler's approvals survive a re-run). Guarded by a new `planMeta.exploreStatus` field, deliberately separate from `planMeta.status` — the guard must stop two devices on the same shared trip from double-firing this, without ever flipping the trip out of `idle` (which is what keeps the Map tab showing explore mode in the first place).
  - **"Rescan this area" now works before any plan exists too**: `rescanCorridorCallable.ts` already documented itself as "usable from idle status onward" and its prompt already asks for general nearby-worth-stopping-for finds, not routing-specific stops — it needed no new Claude call, just a status branch (`candidate` + appended to the `worth-a-detour` tier when the trip is idle, `proposed` unchanged otherwise). `+ Add stop` needed no changes at all — it already wrote `locked` unconditionally, regardless of plan state.
  - **Up/down voting restored** (explicitly requested — "with the possibility to also up/down vote as previously"): `voteExploreCandidate` (`src/lib/exploreCandidateActions.ts`) swaps `rank` between a candidate and its immediate neighbor within the same priority tier, a plain client Firestore write like every other corridor-stop action.
  - **Detour badge restored**: the old highlights-review panel's "≈+N km" figure had been dead code since that panel's retirement — `shared/src/geo.ts`'s `buildRouteBackbone`/`estimateDetourKm` were still fully implemented and tested, just uncalled from anywhere live. `ExploreMapScreen` now calls them client-side (free — pure geometry, no API cost) against a backbone of start point + every currently-`locked` stop + end point, so the estimate sharpens as more stops get locked in.
  - **Map + list, click-to-highlight both ways** (explicitly requested, matching the existing Day View pattern): candidate markers on the map above, grouped-by-priority-tier cards in a list below (`ExploreCandidateCard.tsx`); tapping either a marker or a card sets the same `selectedId` state and highlights/pans to the other.
  - **Confirmation before every expensive generation, not just this new path** (the explicit ask): new `ConfirmGenerateDialog` component sits in front of both `SettingsScreen`'s Generate/Re-plan/Retry button and `ExploreMapScreen`'s "Generate full plan" button — a plain inline panel (not a browser `confirm()`), consistent with every other confirmation-shaped interaction already in this app. Refactoring `SettingsScreen`'s old direct-fire button into "open dialog, confirm to submit" needed its old synchronous rapid-click debounce guard (`event.currentTarget.disabled` set in the same tick as the click, since React's own `disabled` prop re-render is too slow to catch a fast double-click) moved into `ConfirmGenerateDialog` itself, where it now protects both call sites.
  - **Committing seeds the real generation from exactly what was curated, not a re-run of the highlights phase**: a new `fromExploreCandidates` planRequest kind reads every surviving `candidate`/`locked` stop, regroups them back into the same shape the highlights phase itself produces (`buildRegionHighlightsFromCandidates`, `functions/src/exploreCandidates.ts`), and `generateRealPlan` gained an optional `highlights` parameter that — when supplied — calls `generateSkeletonFromHighlights` directly instead of `planTrip`, skipping the (Claude-costed) highlights call entirely. The existing wipe-all-corridorStops-then-write-committed-ones step inside `writeGeneratedDays` already clears the candidate scaffolding as a side effect of committing — no new cleanup code needed. The resumable-generation checkpoint hash (`computeSettingsHash`) is suffixed when highlights are supplied, so a checkpoint from one path can never be silently resumed by the other at the same settings.
  - **Not built, explicitly out of scope for this pass**: real Directions-based (vs. haversine) detour figures for candidates (the existing detour math already documents this upgrade path — `findCheapestBackboneLeg` tells a caller exactly which two backbone points to route between — just not wired up here); region-level collapsing/filtering in the candidate list (flat-within-tier was enough for this pass); a "why here" free-text note per candidate beyond what Claude already provides (the old pause's free-text note field wasn't re-requested).
  - Covered by: `functions/src/exploreCandidates.test.ts` (flattening/regrouping, geocoding-drop, region fallback); `functions/src/exploreHighlightsCallable.test.ts` (write path, busy-guard concurrency, exploreStatus cleared even on failure); `functions/src/generatePlan.exploreCandidates.test.ts` (no-candidates error with zero Claude calls, `generateRealPlan`'s highlights-vs-planTrip branching, checkpoint cross-contamination guard); extended `functions/src/rescanCorridorCallable.test.ts` (idle→candidate branching, rank continuation across repeated rescans); new `e2e/explore.spec.ts` (empty state, credential-less "find stops" degradation, voting, lock/reject, confirm-before-commit); extended `e2e/map.spec.ts`/`e2e/cost-guards.spec.ts` for the removed idle banner and the confirm-dialog-wrapped rapid-click guard. Full suite: 179 backend tests, 62 e2e tests, clean `tsc -b`/`npm run lint`/`npm run build`.

- [x] **White banner "on top" in dark mode** (reported 2026-07-31 — "Something with dark mode again?"; root-caused and fixed same day) — correctly suspected as another dark-mode gap, but not in any component: neither `html` nor `body` (`src/index.css`) had a `background-color` set at all, so the raw document background defaulted to the browser's own white regardless of theme. Invisible almost everywhere (`AppShell`'s `.surface` main element fills the viewport), but a real white strip shows through wherever that gap is exposed — most commonly a mobile overscroll/pull-down bounce past the fixed `h-svh` app container, which is exactly a "banner on top" a phone user would see. Verified by measuring `getComputedStyle(document.body).backgroundColor` before/after in a scripted dark-mode Playwright session with the document scrolled past its bounds (simulating the bounce) — white before the fix, `oklch(0.145 0 0)` (neutral-950, matching every other dark surface in the app) after. Fixed: `html, body { @apply bg-neutral-100 dark:bg-neutral-950; }` in a new `@layer base` block, same neutral scale as `.surface`, so the document background is never visually distinguishable from the app's own regardless of where a gap is exposed. No component-level test surface for this (it's a document-root style, not a component), verified via the scripted measurement above instead; not added as a permanent e2e test since simulating a real touch-overscroll bounce in Chromium headless is synthetic (`scrollBy` on a non-scrollable fixed-height document) rather than a real repro of the mobile gesture.

- [x] **Six real-device bug reports, one session** (reported 2026-07-31 with screenshots from an actual iPhone; investigated and fixed same day) — the white-banner fix from earlier the same day was tested live and turned up a batch of further issues, all root-caused from the screenshots rather than guessed:
  - **White status bar still showing.** The `html`/`body` background fix earlier the same day was correct but incomplete: `theme-color` (`index.html`) was still `#171717` (Tailwind's neutral-900), one shade off the `neutral-950` the body/`.surface` actually render, and the PWA manifest's `theme_color`/`background_color` (`vite.config.ts`) were still a stale green (`#0f764d`) left over from before the monochrome palette redesign — governing the install-time splash screen and OS-level PWA chrome, not the in-page CSS at all. Both synced to `#0a0a0a` (neutral-950). Also added `apple-mobile-web-app-capable`/`apple-mobile-web-app-status-bar-style: black-translucent`, needed for the status bar to be themeable at all once added to the home screen — in a plain (non-installed) Safari tab, that literal OS status bar area follows the phone's own system Appearance setting, not the webpage, and no meta tag changes that.
  - **Trip deletion** (explicitly requested alongside the diary question — diary itself re-verified as already correctly trip-scoped, `useLog(tripId)` reads `trips/{tripId}/log`, no regression) — new `deleteTrip` callable (`functions/src/deleteTrip.ts`) recursively deletes the trip doc and every subcollection (`db.recursiveDelete`), plus the share code and every member's `users/{uid}/trips/{tripId}` reverse-index entry, not just the caller's — a shared trip deleted by one traveler disappears from every member's "My trips," not just 404s next time they open it. Any member can delete (no owner/admin distinction exists anywhere else in this app's trust model). UI: an inline ✕/confirm/cancel per row in `TripSwitcher.tsx`, no modal. Deleting the active trip switches to another remaining trip or mints a fresh one (`AppShell.tsx`'s `handleDeleteTrip`) rather than leaving the app stuck loading a trip that no longer exists.
  - **"Could not link Google account" on an iPhone.** `linkGoogleAccount` (`src/lib/accountBackup.ts`) only ever tried `linkWithPopup` — mobile Safari, and especially an installed/standalone PWA (no normal browser chrome to host a popup in), frequently can't open or complete an OAuth popup at all, surfacing as this generic failure with no diagnostic detail. Fixed: falls back to `linkWithRedirect` specifically on `auth/popup-blocked`/`auth/operation-not-supported-in-this-environment` (a deliberately closed popup stays a real cancel, not a fallback trigger); a new `completePendingGoogleLinkRedirect`, called on `AccountBackupMenu` mount, finishes the flow — including the same `credential-already-in-use` merge path popup already had, extracted into a shared `mergeIntoSurvivingAccount` helper since Firebase surfaces that failure identically either way. Also: `auth/operation-not-allowed` (the Google sign-in provider not being enabled for this Firebase project at all — a console setting, never fixable by retrying) now gets its own distinct message instead of the generic one.
  - **Previous trip showing as "Untitled trip" after creating a new one** — actually two things at once, confirmed from the screenshots: the entry the switcher displayed WAS the brand-new trip (correctly unnamed, `trip.name || 'Untitled trip'` in `TripSwitcher.tsx` working as designed), and the real bug was the *previous* ("Skagen") trip being entirely absent from "My trips" (shown as "My trips (0)" while it was the active trip) — a trip whose `trips/{tripId}/members/{uid}` doc existed (it loaded and was editable fine) but whose `users/{uid}/trips/{tripId}` reverse-index doc never got written, permanently hiding it from the switcher. Root cause: predates the reverse-index feature, or landed via some other write path that skipped it. Fixed with a self-heal in `useTripSession.ts`: on resuming a `storedTripId`, check for the reverse-index doc and backfill it if missing (never overwrites an existing one's real `joinedAt`). Required loosening `firestore.rules`' `users/{uid}/trips/{tripId}` write rule from `false` to `request.auth.uid == uid && isMember(tripId)` — safe because it only lets a caller index a trip they're already a genuine (Admin-SDK-verified) member of, under their own uid path; not a new capability, just who's allowed to perform a write that was previously Admin-SDK-only.
  - **Origin/destination field: screen goes black on the first typed letter, only recoverable by scrolling up.** Root cause was the keyboard scroll-into-view fix from earlier in the project (`AppShell.tsx`'s `visualViewport` `resize` listener): it re-ran on *every* resize event with no guard. Google's `PlaceAutocompleteElement` expands into its own full-screen mobile suggestion overlay once the traveler starts typing — a behavior separate from the keyboard opening — which fires a further wave of `visualViewport` resizes on its own, and the listener kept fighting that overlay for scroll position on each one. Fixed: only re-scrolls when the shadow-DOM-resolved focused element is actually a *different* element than the one last scrolled to, so the original one-time "keyboard just opened" fix still works but doesn't repeat itself against an already-focused field as the overlay around it changes shape.
  - **New trip should inherit the previous trip's settings, only origin/destination reset.** `startNewTrip` (`useTripSession.ts`) now accepts the previous trip's `TripSettings` and, after the usual blank `createTrip` call, patches every field back in except `startPoint`/`endPoint` — a plain client-side `updateDoc`, not a new callable parameter, so `createTrip` stays the same "make me a blank trip" primitive every existing test already exercises.
  - Covered by: `functions/src/deleteTrip.test.ts` (subcollection/share-code/every-member's-reverse-index cleanup, non-member rejection, not-found); extended `functions/src/firestore-rules.test.ts` (self-heal write allowed for a trip the caller belongs to, still denied for one they don't, still denied into another user's own list); extended `e2e/trip-management.spec.ts` (settings inheritance minus start/finish points, delete-a-trip and delete-the-active-trip-switches-away, an old trip missing its reverse-index doc reappearing in "My trips" after a reload). **Not covered by an automated test**: the actual Google OAuth popup/redirect flow (no real Google account in this sandbox, same standing limitation as the rest of account linking) and the mobile Safari autocomplete-overlay scroll fix (headless Chromium doesn't reproduce iOS's visual-viewport/PlaceAutocompleteElement interaction — same caveat as every other real-device-only fix in this app).

- [x] **A brand-new trip was unreachable: settings edits wrongly marked it "stale," hiding both the Generate button's real label and explore mode entirely** (reported 2026-07-31 with screenshots — "even with a new trip, it calls it stale and replan"; "unclear how to trigger the initial rough plan"; root-caused as one bug, not two, and fixed same day) — `updateTripSettings.ts` set `planMeta.status: 'stale'` unconditionally on every settings write, with no regard for the trip's actual current status. For a trip that had never been generated (`'idle'`), the very first settings edit — including the automatic write from the previous trip's inherited settings just landing (see "New trip inherits settings" above) — flipped it straight to `'stale'`, a status that's only supposed to mean "a real plan existed and is now out of date." Two compounding, visible effects from that one wrong write: `SettingsScreen` showed "Re-plan trip" instead of "Generate plan" (`GENERATE_LABEL['stale']` vs `['idle']`), and — more seriously — `OverviewMapScreen` only renders explore mode for `planStatus === 'idle'` exactly, so the Map tab fell through to the post-generation view instead: a header reading "0 km / 0 min/day avg / 0 days," a "Request changes" button that makes no sense pre-generation, and no "Find great stops"/"Generate full plan" trigger anywhere — explaining the report that there was no visible way to kick off the first plan at all. Fixed: `updateTripSettings` now takes the trip's current `planMeta.status` and only writes `'stale'` when it's actually `'ready'`; every other status (`idle`, `error`, `pending`, `generating`) is left alone, since none of them have a valid plan for an edit to invalidate.
- [x] **Traveler name/age fields (and other compact inputs) zoomed the whole page in on focus, on iOS** (reported 2026-07-31 with a screenshot; fixed same day) — `.field-sm` (`src/index.css`, used by 8 components: traveler rows, join-code input, corridor/custom-stop forms, execution-mode manual-position inputs, the interests free-entry field) rendered at `text-sm` (14px). iOS Safari auto-zooms the entire page in when focusing any input/select/textarea under its 16px threshold, and never zooms back out on blur — exactly the reported "zooms in unnaturally, forcing the user to zoom out again." Fixed: `.field-sm` now renders at `text-base` (16px, the documented minimum that avoids triggering it) — same padding, just no longer small enough to trip the threshold. Also found and fixed the same risk on `PlaceCard.tsx`'s "mark done" note textarea, which explicitly overrode back down to `text-xs` on top of `.field-sm`.
  - Covered by: rewrote `e2e/settings.spec.ts`'s single settings test into two — one confirming a fresh (`idle`) trip's settings edits keep it `idle` through a reload (previously asserted the wrong, buggy `'stale'` outcome), a new one seeding `planMeta.status: 'ready'` via the admin SDK first and confirming *that* trip really does go `stale` on edit, preserving coverage of the intended behavior. **The iOS auto-zoom fix has no automated test** — same standing limitation as every other real-device-only visual behavior in this app (headless Chromium doesn't reproduce Safari's zoom-on-focus at all); verified by inspecting the actual root cause (the 14px threshold) rather than a screenshot-diff.

- [x] **New-trip inheritance missed the free-text notes field** (reported 2026-07-31 — "Notes are not carried over on new trip creation"; fixed same day) — the settings-inheritance fix above (see "Six real-device bug reports") only ever carried over `trip.settings.*` fields; a trip's free-text notes live in a sibling `trip.notes.freeText` field, untouched by that write, so a new trip's notes always started blank regardless of what the previous trip had. `startNewTrip` (`useTripSession.ts`) now takes `{ settings, notesFreeText }` together and patches both onto the fresh trip (`notes.updatedAt` also refreshed, matching `NotesScreen.tsx`'s own save pattern). Covered by extending the existing settings-inheritance e2e test in `e2e/trip-management.spec.ts` to also seed and assert on `notes.freeText`.

- [x] **Investigated: does a long (e.g. 30-day, multi-country) generation survive `generatePlan`'s 540s Cloud Functions timeout?** (raised 2026-07-31 as a suspected issue, not yet reported broken) — confirmed via live docs that 540s is a hard, non-adjustable ceiling for Cloud Functions v2 event-driven triggers (`onDocumentCreated`) specifically — not a value this codebase chose, and not the same limit the existing `CHUNK_SIZE = 7` chunking in `prompts/planTrip.ts` already handles (that solves the Anthropic SDK's own separate ~10-minute per-call streaming guard). Traced the actual budget consumers: `resolveSkeletonDays` (`planPipeline.ts`) is deliberately sequential day-by-day (each day's geocoding bias/drive-leg origin depends on the previous day's resolved location — documented in its own code comment), and the detail-chunk loop in `planTrip.ts` is also sequential. A genuinely long trip can still exhaust the 540s budget even with chunking, since every chunk and every day still runs inside one invocation. The real fix for that is a segmented/self-chaining generation (reusing the existing checkpoint primitives in `planCheckpoint.ts`, which already cover most of what resuming a chained run would need) — not yet built, flagged as a larger follow-up.
  - As a smaller, lower-risk first step: parallelized the per-item Places resolution inside `enrichActivities`/`enrichRestaurantsForMeal` (`placesApi.ts`). Each day's four enrichment calls (activities, breakfast, lunch, dinner) were already run concurrently via `Promise.all` in `planPipeline.ts`; what was still sequential was the loop *within* each of those four calls, resolving one proposed activity/restaurant at a time. New `resolveBatch` helper fires the always-run text-search call for every item in the batch at once via `Promise.all`, then walks the results in strict original order to pick matches and update the shared `excludeIds` set — only the (comparatively rare) nearby-search fallback stays sequential, since which items still need it, and which ids are already taken, depend on how earlier items in the same batch resolved. Preserves `resolveOne`'s exact one-at-a-time selection semantics (same item wins the same contested place, same order), just with the network round trips overlapped. `backfillActivities`/`backfillRestaurantsForMeal` (the adaptive, count-driven top-up loops) were left sequential — parallelizing an unknown, usually-small shortfall risks over-fetching for little gain. This alone does not fix the 30-day timeout risk (the dominant cost is the cross-day sequential chain, which this doesn't touch) — it's a real, independent latency win, not a substitute for the segmented-architecture fix above. Covered by the existing `placesApi.test.ts` suite (all 9 tests still pass unchanged, since they assert on outcomes/counts rather than raw fetch-call ordering).

- [x] **Segmented/chained plan generation, Phase 1: day-resolution** (built same day, following straight on from the timeout investigation above once asked "when can this be started") — the real fix for a trip long enough to exhaust `generatePlan`'s 540s budget even with the Places parallelization above: instead of one invocation racing the whole day-resolution phase against the clock, it now bails out cleanly before the deadline and hands the rest to a fresh invocation with a full new budget.
  - `resolveSkeletonDays` (`planPipeline.ts`) takes an optional `deadlineMs`: before starting *any* further day, it checks `Date.now()` against the deadline and stops if past it, returning whatever's resolved so far — every day it did resolve is already durably staged via the existing `onDayGenerated`/`stageGeneratedDay` checkpoint mechanism (built 2026-07-27 for crash recovery, reused here unchanged). Return type deliberately untouched (`GeneratedDay[]`, just possibly shorter than the input) so every existing caller/test — including `replanTrip.ts`, which doesn't pass a deadline and is explicitly not in scope here (its remainder is short enough not to need this) — is unaffected.
  - `generateRealPlan` (`generatePlan.ts`) now returns `{ days, complete }` instead of a bare array: `complete` is `days.length === skeleton.days.length`, i.e. "did resolveSkeletonDays actually finish." Threads a new `deadlineMs` param straight through.
  - The trigger's old inline generation logic was extracted into a new exported `runFullGeneration(tripId, kind, invocationDeadline)` — the same "extract out of the onDocumentCreated closure so it's directly testable" move `writeGeneratedDays` already used, since the Functions emulator runs the compiled bundle in its own process and a test can't reach trigger-closure-only code by mocking it. `invocationDeadline = Date.now() + GENERATION_TIME_BUDGET_MS` (480s, 60s under the hard 540s ceiling — headroom for this invocation's own final writes and the continuation doc it chains). When `generateRealPlan` reports `complete: false`, `runFullGeneration` writes a new `planRequests` doc (`{ tripId, kind, status: 'pending', isContinuation: true }`) and returns without touching `writeGeneratedDays`/pacing validation/`planMeta.status` — the trip stays `generating` for the next invocation to pick up.
  - The busy-guard claim transaction (one active plan request per trip) now branches on `isContinuation`: a continuation doesn't re-claim (the parent invocation's claim is still in effect) — it only confirms `planMeta.status` is still `'generating'` before proceeding, which both lets a legitimate chain through and drops a stray/misfired continuation (trip deleted, or reset by an unrelated error) without touching trip state.
  - **Explicitly out of scope for this pass, flagged not silently ignored**: the upstream Claude skeleton call (`planTrip`/`generateSkeletonFromHighlights`) produces the whole skeleton in one shot with no partial-checkpoint support, so it isn't deadline-aware or chainable yet — an extremely long trip could in principle still exceed budget before day-resolution even starts. Day-resolution was the right first target since it's already the dominant cost for the reported 30-day case and already had per-day checkpoint infrastructure to build on; segmenting the skeleton phase too is a real, larger follow-up if a trip long enough to hit that ceiling actually comes up.
  - Covered by: 4 new tests in `planPipeline.test.ts` (`resolveSkeletonDays` — stops before touching Places/Routes once the deadline's already past; resolves everything with a comfortable deadline; stops partway when a slow day pushes past a tight one; unaffected when no deadline is passed at all); 3 new tests in `generatePlan.checkpoint.test.ts` (`generateRealPlan` reports `complete: false` and leaves the checkpoint intact on a short return; `runFullGeneration` chains a continuation and leaves the trip `generating` rather than finalizing a partial plan; `runFullGeneration` still finalizes normally — `ready`, checkpoint cleared, no continuation — when nothing was cut short); 2 new tests in `costGuards.test.ts` (a continuation is let through the busy guard while the trip is `generating`, unlike a fresh request; a continuation against a trip that's no longer `generating` is dropped without touching the trip). Full suite: 193 backend tests, clean `tsc`/lint.

- [x] **"Generate overview" button on Trip Setup, alongside "Generate full plan"** (requested 2026-07-31 — "There should be a button from the trip setup which is 'Generate overview' the other should be 'Generate full plan'") — explore mode (the cheap, repeatable curation pass) was previously only reachable by navigating to the Map tab and clicking "Find great stops" there; `SettingsScreen`'s own generate button only ever fired the expensive full generation, with a line of description text just *telling* the traveler to go find the Map tab themselves. `GENERATE_LABEL.idle` renamed to "Generate full plan"; a new "Generate overview" button (shown only for `idle` trips, alongside it) calls the same `generateExploreHighlights` callable the Map tab's own button already uses, then navigates to `/map` so the traveler lands directly on the results — no confirmation dialog, matching that callable's existing "cheap, repeatable" characterization elsewhere in this app. Covered by a new `e2e/settings.spec.ts` test (both buttons present with the right labels; a credential-less failure — same degradation `explore.spec.ts` already exercises — surfaces inline without navigating away).

- [x] **"find great stops" failed outright for a trivial/short (e.g. one-day) trip** (reported 2026-07-31 — "find great stops for a 1 day plan doesn't work?"; root-caused and fixed same day) — `regionHighlightsResponseSchema.regions` and `regionHighlightSchema.candidateStops` both required `.min(1)`, but a genuinely trivial corridor (start and finish close together, or a short local trip) can legitimately have nothing worth flagging as a special detour — the *only* way for Claude to satisfy the schema on such a trip was to invent a padded candidate or retry into the exact same honest-but-empty response twice and then hard-fail. This is the shared highlights phase (`generateRegionHighlights`) both explore mode and the plain "Generate full plan" path call first, so the same failure applied to both, not just explore mode. Fixed: dropped both `.min(1)` constraints (`planTripSchema.ts`), and added an explicit line to `HIGHLIGHTS_SYSTEM_PROMPT` sanctioning an empty `regions`/`candidateStops` array as an honest answer rather than something to pad around. The rest of the pipeline already handled this correctly once let through: the outline prompt already has explicit license to "add a plain connecting overnight stop" when candidates don't cover a leg, and the UI already renders a "No stops yet" empty state. Covered by rewriting `parseRegionHighlights`'s schema-violation test in `planTrip.test.ts` — the old test asserted `{"regions": []}` should throw (the very behavior being fixed); replaced with a test asserting it parses successfully, alongside a genuinely malformed response still throwing.

- [x] **Switching trips showed stale settings; the browser tab title never reflected the trip** (reported 2026-07-31 — "Loading trips erases travel dates and destinations", "the title is not continuously updated with the trip title"; both root-caused and fixed same day) — two unrelated bugs:
  - **Stale settings on switch.** `SettingsScreen`'s local `settings` state was seeded once via `useState(trip.settings)`, but `SetupScreen.tsx` renders it with no `key={tripId}`, so switching the active trip re-renders the *same* component instance with new `tripId`/`trip` props rather than remounting it — the `useState` initializer never re-runs, so the form kept showing whichever trip's settings it happened to first mount with. Harmless on the very first switch to a never-before-loaded trip (that one does briefly unmount/remount while its data loads), but switching *back* to an already-cached trip (the client-side trip store, `useTripStore`, never evicts) showed the wrong trip's dates/destinations — read by the reporter as switching trips "erasing" them. Fixed with a render-time resync keyed on `tripId` (`if (tripId !== syncedTripId) { setSyncedTripId(tripId); setSettings(trip.settings) }`) — the same pattern `NotesScreen.tsx` already uses for its own local text state, just keyed on `tripId` instead of `notes.updatedAt` since `TripSettings` has no per-edit watermark and the reported case is specifically about switching, not live cross-device sync mid-edit.
  - **Tab title never set.** `document.title` was never touched anywhere in the app — a static `<title>RV Road Trip Planner</title>` in `index.html` forever, regardless of which trip was open. Added a `useEffect` in `AppShell.tsx` keyed on `trip?.meta.name`, setting it to `"{name} · RV Road Trip Planner"` (or the plain default when blank/no trip loaded) — reruns on every trip switch or rename, not just once on load.
  - Covered by two new `e2e/trip-management.spec.ts` tests: switching to a new trip (which inherits dates but never start/finish points — see the earlier inheritance feature) and back again shows the first trip's own start point, not a blank/stale one; the tab title updates on rename and resets to the plain default on switching to a fresh, unnamed trip.

- [x] **Claude calls weren't actually retried on a transient failure, only on malformed JSON** (surfaced via a screenshot — "Bug: clicking rescan doesn't work", "Could not rescan this area right now"; root-caused and fixed same day) — every one of the 4 places in this codebase that call Claude with a hand-rolled retry loop (`callWithRetry` in `planTrip.ts`, plus near-identical copies in `rescanCorridor.ts`, `countryGuide.ts`, `overnightCandidates.ts`) had the same structural gap: `client.messages.create(...)` itself sat *outside* the loop's own `try/catch` — only a schema-parse failure on an already-successful response was ever retried. A transient API-level failure (rate limit, a brief `529 overloaded_error`, a network blip) — the ordinary, expected failure mode for any external API call, and plausibly the actual cause of the reported "rescan doesn't work" — propagated immediately on the very first attempt with zero retries, despite `MAX_ATTEMPTS` existing and clearly implying resilience to exactly this. Fixed identically in all 4: wrapped the `client.messages.create` call in its own `try/catch`, and on failure, record it and retry the identical request (nothing was pushed onto `messages` in that branch, so the retry is a clean resend, not a "please correct this" follow-up — that stays reserved for actual schema failures). Firebase callables strip detail from an uncaught server error before it reaches the client by design, so the client-side "Could not rescan this area right now" message is unchanged — this fixes the underlying failure rate, not the (deliberately generic) error text. Covered by a new "retries once on a transient API-level failure" test mirroring each file's existing "retries once on a schema failure" test, plus a "throws the transient-failure error when every attempt fails at the API level" test for `rescanCorridor.ts` specifically.

- [x] **Custom natural-language search in "Add stop"** (requested 2026-08-01 — "The add stop should allow both the current google search, but also allow custom input to for example 'search for coffe stop along route' or 'search for cozy small lunch place within this map area'"; refined same day after feedback that it "should be based on the route generated by Generate overview" and "should also then show the detour penalty") — `AddCorridorStopForm.tsx` gained a mode toggle: "Pick a place" (the existing Google Places autocomplete, unchanged) and a new "Describe it" mode, a free-text query that reuses the `rescanCorridor` pipeline (Claude + web search) `RescanCorridorButton`'s plain "Rescan this area" already runs, with the query steering what it looks for instead of the generic "what's worth stopping for" pass. `rescanCorridorPrompt.ts`/`rescanCorridor.ts`/`rescanCorridorCallable.ts` all gained an optional `query` param threaded straight through (`focusQuery` in the prompt payload); the shared `httpsCallable` wiring was factored out of `RescanCorridorButton.tsx` into a new `src/lib/rescanCorridorAction.ts` so both callers share it instead of a second hand-rolled copy.
  - **Found along the way: the search anchor was silently wrong.** `ExploreMapScreen.tsx` passed a *fixed* `trip.settings.startPoint` to both `AddCorridorStopForm` and `RescanCorridorButton` as their search center — never the map's actual live-panned position, even though `OverviewMapScreen.tsx` already tracks that correctly (`onCameraChanged` → `setCenter(event.detail.center)`). Panning the map anywhere else and clicking "Rescan this area"/opening "Add stop" silently searched near the trip's start regardless — this was the likely cause of "clicking rescan doesn't work" screenshots showing an area far from the pin. Fixed by adding the same live-center tracking `OverviewMapScreen` already has.
  - **Route-aware, not just point-aware** (the follow-up ask): a single point+radius doesn't mean anything for "along route" — the traveler would have to manually pan/zoom to every stretch of the route and search each one separately. `generateRescanCandidates`/`buildRescanCorridorPrompt` gained an optional `backbone: LatLng[]` param — the explore-mode route corridor (start → locked stops → end, in route order), the exact same array `ExploreMapScreen` already computes via `buildRouteBackbone` for its own candidate-list detour badges. When given, the prompt describes `routeWaypoints` instead of a single `areaDescription`/`radiusKm`, and server-side filtering switches from `haversineDistanceKm(find, center) <= radiusKm` to `estimateDetourKm(find, backbone) <= MAX_QUERY_SEARCH_DETOUR_KM` (30km) — the identical shared (`@rv/shared`) detour math the frontend already uses for display, so backend filtering and frontend detour badges can never disagree about what counts as "on the route." `AddCorridorStopForm` takes `backbone` as an optional prop, passed only from `ExploreMapScreen` (where "the route so far" is a meaningful concept); `OverviewMapScreen`'s post-generation "Add stop" stays point-scoped, unchanged.
  - **The detour badge itself needed no new code.** A search result lands as a `candidate` corridorStop exactly like a plain rescan already does while the trip is `idle` (existing `isExploring` branching in `runRescanCorridor`), and `ExploreMapScreen` already computes `estimateDetourKm` uniformly for every entry in its candidate list regardless of source — so once a query-search find is written, it shows the same detour badge via `ExploreCandidateCard` automatically.
  - Covered by: new tests in `rescanCorridor.test.ts` (focusQuery included/omitted in the prompt payload; a backbone-following find kept despite being outside `radiusKm`/far from `center`, an off-route find dropped despite being technically closer to `center` — proving detour, not distance, is the real filter; `routeWaypoints` sent instead of `areaDescription`/`radiusKm` when backbone is given; falls back to point+radius when backbone has fewer than 2 points); new tests in `rescanCorridorCallable.test.ts` (query and backbone both threaded through to the generator); new `e2e/corridor.spec.ts` test ("Describe it" mode requires a description client-side, then degrades to the same credential-less error banner the plain rescan test already exercises, confirming it reaches the real backend call rather than being a no-op). **Not covered by an automated test**: the actual detour badge rendering for a live query-search result (would need real Claude/Places credentials this sandbox doesn't have, same standing limitation as every other Claude-touching UI flow here) — verified instead by tracing that it reuses the exact same `status: 'candidate'` write path and `ExploreMapScreen` candidate-list rendering already covered by `explore.spec.ts`'s voting/lock/reject tests.

- [x] **"Generate overview" silently returned 0 stops with no explanation** (reported 2026-08-01 with a screenshot — "When I tried to generate overview it didn't work and I got this" — an empty Map with "No stops yet" and no error banner; root-caused and fixed same day) — a trip's `startPoint`/`endPoint` default to `{ name: '', lat: 0, lng: 0 }`, and critically **never get filled in by the settings-inheritance feature** (that fix explicitly excludes them, on purpose — see the "New trip inherits settings" entry above). `(0, 0)` is a real-looking coordinate, not an obviously-missing one, so nothing downstream — not `generateExploreHighlights`, not the outline prompt, not `buildRouteBackbone`/`estimateDetourKm` — ever rejected it; Claude was silently asked to plan a corridor from a real start point to a spot in the Gulf of Guinea and reasonably found nothing worth flagging on that "route," returning a valid-but-empty response (exactly the honest-empty-response case the schema-relaxation fix earlier this session made possible — this is a **different** bug that fix's own relaxation happened to unmask, not a regression it caused). Matches the reported flow exactly: create a new trip (inherits everything except the route), fill in only a start point, click "Generate overview" straight away.
  - Fixed with a new `hasRoute(settings)` helper (`src/lib/validateRoute.ts` — originally just `startPoint.name`/`endPoint.name` both non-blank; tightened on 2026-08-02 to require real coordinates too, see the entry at the end of this list) checked **client-side, before spending any Claude call** — in `SettingsScreen.tsx`'s `generateOverview()` and the "Generate full plan" confirm-dialog opener (a new `routeError` state, shown inline), and in `ExploreMapScreen.tsx`'s `runFindStops()` (reusing its existing `genError` state/`explore-find-stops-error` slot). An instant, free, specific message ("Set a start and finish point…") instead of a wasted Claude call and a confusing empty result three of them shared this same failure mode.
  - Covered by: 5 new unit tests in `validateRoute.test.ts` (true only when both points are genuinely named; false for either blank, both blank, or a whitespace-only name); a new `e2e/settings.spec.ts` test (both generate buttons blocked with no network call at all on a fresh trip; still blocked with only one point set; both proceed once both are set) — the pre-existing "Generate overview"/"Generate full plan" degradation tests were updated to seed a real start/finish first, so they keep exercising the credential-less-failure path they were meant to, not this new guard; a new `e2e/explore.spec.ts` test for the same guard on "Find great stops", with its own pre-existing degradation test updated the same way.

- [x] **"Generate overview" permanently stuck failing with "Could not find stops right now"** (reported 2026-08-01 with two screenshots — the button cycles from "Finding great stops…" back to "Generate overview" without landing on the Map, and a repeat click surfaces the generic error every time) — `generateExploreHighlightsForTrip`'s busy guard (`planMeta.exploreStatus`) has no recovery path if the call never reaches its own `finally`: the `generateExploreHighlights` callable had no `timeoutSeconds` override, so it ran on Cloud Functions' 60s default, while a large trip (the reporting screenshot had 10 preferred countries selected) can plausibly exceed that between the highlights call's own retry (`MAX_ATTEMPTS` in `planTrip.ts`) and geocoding every candidate town afterward. If the platform kills the container on timeout, `planMeta.exploreStatus` is left stuck at `'generating'` forever — every subsequent click then fails immediately inside the claim transaction with `HttpsError('failed-precondition', 'Already finding great stops…')`, which the client renders as the generic "Could not find stops right now" (masking the real, permanent-lock reason).
  - Fixed two ways: (1) `generateExploreHighlights` now sets `timeoutSeconds: 180`, well above the worst-case retry+geocode path, so this should rarely trigger in the first place; (2) the lock is now self-healing regardless — a new `planMeta.exploreStatusUpdatedAt` timestamp is written alongside `exploreStatus: 'generating'` when the transaction claims it, and a claim attempt that finds the lock already `'generating'` now reclaims it instead of rejecting if that timestamp is more than `STALE_EXPLORE_LOCK_MS` (5 minutes) old — recovering a trip from a genuinely abandoned run without ever racing a real in-flight one (5 minutes comfortably exceeds the new 180s timeout).
  - Covered by: 2 new tests in `exploreHighlightsCallable.test.ts` (a lock stuck 10 minutes old is reclaimed and the run completes normally; a lock only 30 seconds old is still respected and rejects a concurrent call exactly as before) — the pre-existing concurrent-lock test is unaffected since a freshly-claimed timestamp is never stale.

- [x] **First full code-quality review of the codebase** (requested 2026-08-01 — "All of the code was written by Sonnet, go over the code quality and fix if there are any issues... treat it like a pull request review of the full code, as this has not been done") — four parallel review passes covering `functions/src/prompts` + `shared/src`, the rest of `functions/src`, `src/screens` + `src/lib`, and `src/components`. The most severe, highest-confidence findings were fixed; lower-severity findings (frontend double-submit/error-surfacing gaps, a11y misses, dead code, `mergeTrips`/`deleteTrip`'s unchunked batches, `clearCheckpoint`'s unchunked batch and its misleading error-on-cleanup-failure, the `accountBackup.ts` sign-in-before-merge-confirmed ordering, and generalizing the exploreStatus stale-lock fix to `planMeta.status`) were left as documented follow-ups rather than fixed in this pass, to keep the diff reviewable.
  - **[Critical] IDOR — 6 of 7 tripId-taking `onCall` callables never verified the caller belonged to the trip.** `rescanCorridor`, `generateExploreHighlights`, `refreshCountryGuide`, `getOvernightCandidates`, `researchMoreAlternatives`, and `previewReconcileCorridor` all checked `request.auth` (signed in at all) but trusted `request.data.tripId` verbatim — only `deleteTrip.ts` had the real check. Since `onCall` runs on the Admin SDK, `firestore.rules`' `isMember()` never applies to these at all — this was the *only* authorization boundary, and it was missing on 6 of 7. Any signed-in (including anonymous) user who obtained another trip's `tripId` could burn that trip's Claude/Places quota or mutate its `corridorStops`/`countries` data. Fixed with a new shared `functions/src/authz.ts` (`requireTripMember(tripId, uid)`, mirroring `deleteTrip.ts`'s existing check) wired into all 6.
  - **[Critical] `firestore.rules`' `planRequests` collection had no membership check at all** (`allow create: if request.auth != null`) — since a `planRequests` doc is exactly what triggers `generatePlan.ts`'s expensive Claude/Places/Routes pipeline, any signed-in user could fire a full generation against a trip they don't belong to, just by knowing its `tripId`, silently overwriting that trip's real days. Fixed: `allow create: if isMember(request.resource.data.tripId)`, `allow read: if isMember(resource.data.tripId)`.
  - **[Medium] `overnightCandidates.ts` trusted Claude's raw `lat`/`lng` with zero validation** — unlike every other Claude call in this codebase (`planTrip.ts`'s own doc comment: "Claude is deliberately not asked for coordinates — models invent plausible-looking wrong ones"), the stellplatz-fallback/wild-camping generator has no Places geocode step to fall back on, so a hallucinated coordinate went straight to the traveler as a legitimate "nearby" option. Fixed with a `MAX_CANDIDATE_DISTANCE_KM` (50km) haversine sanity filter against the requested point — the best available guard given there's no queryable database to geocode these place types against.
  - **[Medium] `buildCorridorStopWrites` merged *any* days sharing a coordinate, not just consecutive ones**, contradicting its own doc comment ("consecutive rest days... merge"). A loop trip revisiting its starting town, or a hub-and-spoke itinerary returning to a base campsite, collapsed two unrelated visits into one `corridorStops` doc whose `linkedDayIds` spanned non-contiguous days — `corridorReconciliation.ts` treats each doc as one contiguous block, so reordering/removing that stop would move or delete days from two unrelated points in the itinerary together. Fixed with a linear adjacency-only grouping pass instead of a plain coordinate-keyed `Map`.
  - **[Low-Medium] `rescanCorridor`, `refreshCountryGuide`, `getOvernightCandidates`, `previewReconcileCorridor` also had no `timeoutSeconds` override**, same class of gap as the `exploreStatus` stuck-lock bug above — all run a retried Claude call (sometimes with `web_search`), which can plausibly exceed the 60s default. Given the same 180s override.
  - Covered by: `functions/src/authz.test.ts` (new, unit tests `requireTripMember` directly); a new "rejects a non-member" test per callable (using `onCallExport.run({data, auth})`, the same technique `firebase-functions/v2/https` exposes for testing an `onCall` handler without the HTTP layer) in `rescanCorridorCallable.test.ts`, `exploreHighlightsCallable.test.ts`, `countryGuideCallable.test.ts` (new file — this callable had no test coverage at all before), `overnightCandidatesCallable.test.ts`, `researchMoreAlternativesCallable.test.ts`, `previewReconcileCorridorCallable.test.ts`; `firestore-rules.test.ts`'s `planRequests` tests corrected (the old test literally asserted the vulnerable behavior — "lets any authenticated user create a plan request" — now split into a member-succeeds and a stranger-denied case, plus a new read-side member/stranger pair); a new regression test in `overnightCandidates.test.ts` (a far-away hallucinated candidate is dropped, a nearby one kept); a new regression test in `corridorStops.test.ts` (a loop trip's two non-consecutive visits to the same coordinates stay as two separate stops). Full suite: 223 backend tests (was 208), 72 e2e tests, clean `tsc -b`/`npm run lint`/`npm run build`.

- [x] **Explore map showed no route line, and a legitimate "nothing found" result was indistinguishable from "haven't searched yet"** (reported 2026-08-01 with a screenshot — "Starts generating overview. Jumps to map. No route and no activities" — a real, distinct start/finish pair a genuine short hop apart, "Find great stops" completing successfully (it navigates to `/map` only on success) and landing on an empty candidate list) — two separate, real gaps, not a repeat of either previously-fixed bug (the route wasn't blank `(0,0)`, and the busy-lock wasn't stuck): (1) `ExploreMapScreen.tsx` never rendered a route line between start and finish — only bare markers — unlike `OverviewMapScreen.tsx`/`DayViewScreen.tsx`, which both already use the shared `DirectionsRoute` component; (2) a genuinely empty highlights result (which `planTripPrompt.ts`'s own system prompt explicitly sanctions for "a short or local trip" — "an empty regions array... is a valid and honest answer") rendered the exact same generic "No stops yet — tap Find great stops..." text whether or not the traveler had already tried, making a correct, honest empty response look identical to a broken button.
  - Fixed: `ExploreMapScreen.tsx` now renders `<DirectionsRoute points={backbone} onError={setRouteError} />` (the same `backbone` — start → locked stops → end — it already computes for detour badges), with the same amber degradation banner `OverviewMapScreen.tsx` shows if the real directions request fails. `runFindStops()` now reads the callable's own `candidateCount` return value and sets a new `searchedEmpty` flag when it's `0`; the empty-state message branches on it — "No stops yet — tap..." before any attempt, vs. "Nothing stood out along this route — for a short or local trip, that can be the honest answer..." after a real, completed, empty search.
  - Not covered by a new automated test: this codebase has no component-level test harness for map screens (`@vis.gl/react-google-maps` isn't mocked anywhere), and e2e can't reach the success-with-zero-candidates path without real Claude credentials this sandbox doesn't have — verified instead by full `tsc -b`/`npm run lint`/`npm run build` and the existing `e2e/explore.spec.ts` suite (still passing, including the default-empty-state and credential-less-degradation cases this change sits next to).

- [x] **"Switching from trip setup to map seems to disable the overview generation"** (reported 2026-08-01) — both `SettingsScreen.tsx`'s "Generate overview" button and `ExploreMapScreen.tsx`'s "Find great stops" button only tracked their own local "am I submitting" state (`overviewSubmitting`/`generating`), never the real server-side truth (`trip.planMeta.exploreStatus`). A generation kicked off from Trip Setup is genuinely still running after navigating to Map (nothing cancels it — the callable isn't tied to the component's lifecycle), but the local state that showed "Finding great stops…" resets to `false` on every fresh mount, so switching tabs and back made an actually still-in-progress generation look like it had silently stopped or been "disabled" — plus, since the Map screen's button also didn't know a generation was already running, clicking it there would just throw the busy-guard's generic "Could not find stops right now" error.
  - Fixed by deriving a shared `exploring` boolean (`localSubmitting || trip.planMeta.exploreStatus === 'generating'`) in both screens, used for both the button's `disabled` state and its label — so the in-progress state now survives navigation and stays consistent no matter which screen shows it or which one originally fired the call.
  - Covered by a new `e2e/settings.spec.ts` test: seeds `planMeta.exploreStatus: 'generating'` directly (simulating an already-in-flight generation, not one this test itself triggers), then asserts both buttons show "Finding great stops…" and are disabled — on a fresh Trip Setup mount, after navigating to Map, and again after navigating back to Trip Setup.

- [x] **A genuinely empty "Generate overview" result still showed the generic "No stops yet" message, not the honest-empty one** (reported 2026-08-01 with two screenshots — clicking "Generate overview" from Trip Setup, waiting ~30s, landing on Map with the route line now drawn correctly but the generic empty-state text, not the "searched and found nothing" message added for exactly this case) — the `searchedEmpty` distinction from the earlier fix was **local React state inside `ExploreMapScreen.tsx`**, set only inside its own `runFindStops()`. "Generate overview" lives in `SettingsScreen.tsx` and navigates to `/map` on success — mounting `ExploreMapScreen` fresh, with local state reset to its default `false`, with zero memory of the search that had just completed moments earlier from the other screen. This was the exact primary entry point the honest-empty message was built for, and it never fired there.
  - Fixed the same way as the "generation status doesn't survive navigation" bug right above it: moved the truth out of local component state and into the trip document. New `planMeta.exploreLastRunAt` (an ISO timestamp), set by `generateExploreHighlightsForTrip` once a run genuinely *completes* (not on a failed attempt — an error tells you nothing about whether the route has real stops). `ExploreMapScreen.tsx`'s `searchedEmpty` is now `candidates.length === 0 && !!trip.planMeta.exploreLastRunAt` — a derived value from the shared `trip` prop instead of a `useState`, so it's correct regardless of which screen's mount fired the call, and it survives navigation the same way `exploring` (the previous fix) does.
  - Covered by: 2 new tests in `exploreHighlightsCallable.test.ts` (`exploreLastRunAt` set on a completed run even with zero candidates; NOT set when the run throws); a new `e2e/explore.spec.ts` test that seeds `planMeta.exploreLastRunAt` directly (simulating a completed search from either screen, not one the test itself triggers) and asserts the honest-empty message renders instead of the generic one.

- [x] **THE actual root cause: "Generate overview" returned zero stops because `generateExploreHighlights` never declared the Places secret** (reported 2026-08-01 — "Obviously there are things to see along the route. Check why it yields nothing") — the preceding three entries all improved how the *empty result was presented*; this is why the result was empty in the first place, on a Göteborg→Copenhagen-area route that obviously has plenty worth stopping for. `generateExploreHighlights` declared `secrets: [claudeApiKey]` only. It never calls Places directly — but its call chain does: `generateExploreHighlightsForTrip` → `generateRegionHighlights` → `geocodeHighlights` → `geocodeQuery` → `googlePlacesApiKey.value()`. A Cloud Functions v2 secret is only readable by a function that **declares** it, so `geocodeQuery` threw `"GOOGLE_PLACES_API_KEY is not configured"` for *every* candidate. `geocodeHighlights` catches per-candidate (deliberate best-effort: one unresolvable town shouldn't sink a whole generation) and returns that town with no `lat`/`lng`; `buildExploreCandidateWrites` then drops every candidate lacking coordinates. Net effect: Claude correctly found Helsingborg, Malmö, Copenhagen etc., all of them silently evaporated, the callable reported a successful run with `candidateCount: 0`, and the full Claude spend was already incurred. Every sibling Places-touching callable (`rescanCorridor`, `getOvernightCandidates`, `researchMoreAlternatives`, `previewReconcileCorridor`, `generatePlan`) declares it correctly — this one was missed precisely *because* its Places dependency is transitive and therefore invisible in its own import list.
  - Fixed by adding `googlePlacesApiKey` to the declared secrets, plus a **defense-in-depth guard** so this whole class of failure can never silently masquerade as "nothing found" again: if Claude proposed candidates but *none* survived to a write, that's systemic (bad/missing key, quota exhaustion, Places outage) rather than the per-candidate degradation the drop exists for, so it now throws `internal` with "Found N stops but could not locate any of them on the map" instead of returning an empty success. Checked deliberately *before* both the batch commit and the `exploreLastRunAt` write, so a broken run neither half-applies nor gets recorded as a genuine "searched and found nothing". An honest-empty response (Claude proposing nothing at all) still passes through untouched — the two cases are explicitly distinguished.
  - Audited every other callable for the same transitive-secret gap by tracing each one's actual call chain rather than its imports (`countryGuideCallable` legitimately needs only Claude; all others already declared what they reach) — `generateExploreHighlights` was the only one affected.
  - Covered by: 3 new tests in `exploreHighlightsCallable.test.ts` — one asserting the declared secrets (read off the function's own `__endpoint.secretEnvironmentVariables`) include both `CLAUDE_API_KEY` and `GOOGLE_PLACES_API_KEY`, which targets this exact bug class directly and was **verified to fail against the pre-fix code** before being kept; one asserting a total geocode wipeout throws rather than reporting an empty success, leaving no stops written, no `exploreLastRunAt`, and `exploreStatus` back at `idle`; and one asserting the honest-empty case still resolves normally. Full suite: 228 backend tests (was 225), 74 e2e tests.

- [x] **Explore mode interaction pass: pin→card highlight, cross-tier promote/demote, must-see-driven route, live detour re-estimation** (reported 2026-08-01, once generation was finally working end to end — "clicking the pin in the map does not highlight the text section. Also, the promote/demote does not seem to work. Everything should be possible to promote/demote. Also, the route should dynamically update based on the must see, and the detour penalty for others should update based on the new route") — four distinct gaps, all in `ExploreMapScreen`/`ExploreCandidateCard`/`exploreCandidateActions`:
  - **Pin taps highlighted a card nobody could see.** Clicking a marker already set `selectedId` and the card already rendered an orange ring for it — but the candidate list is a separately-scrolling pane below the map, so for any stop past the first couple the ring landed off-screen and the tap read as a no-op. Fixed by registering each card's DOM node in a ref map (new optional `innerRef` prop on `ExploreCandidateCard`) and calling `scrollIntoView({ block: 'nearest', behavior: 'smooth' })` when the selection changes. `block: 'nearest'` deliberately: it scrolls only when the card actually is out of view, so tapping a card that's already visible doesn't jerk the list.
  - **Promote/demote was dead at every tier edge.** `voteExploreCandidate` only ever swapped `rank` with a neighbour *inside the same tier*, and the buttons were disabled at each tier's first/last position — so with the small tiers Claude typically produces, a large share of stops had both arrows greyed out, and **nothing could change `priority` at all**. Reworked so the three tiers behave as one flat ordered list: a vote still moves exactly one position, but when that position crosses a boundary the stop's `priority` changes to match where it landed. Crossing keeps it adjacent to where it came from — promoting enters the tier above at its *bottom* edge, demoting enters the tier below at its *top* edge — so a promote followed by a demote round-trips exactly. Rank is placed just past the destination edge (`max+1`/`min-1`) rather than renumbering the whole target tier: only ordering matters, so this stays a single-doc write, and gaps or negative ranks sort fine. Only the very top of `must-see` and the very bottom of `nice-if-convenient` remain disabled. `TIER_ORDER` moved into `exploreCandidateActions.ts` and imported by the screen — the disabled state and the move logic must agree on tier order, and two copies could drift.
  - **The route ignored the tiers it was asking travelers to curate.** The backbone was `start → locked stops → end`, so promoting something to must-see changed nothing on the map. It's now `start → (locked ∪ must-see) → end`, which is the whole point of the ranking: a "worth a detour" stop 5km off a route already bending through the must-sees is a completely different proposition from one 200km off the bare start→end line. `buildRouteBackbone` already sorts points along the corridor, so promotion order never matters and a mid-trip stop can't land after the destination.
  - **Detour estimates now re-measure against that live route automatically** — `detourByStopId` already derived from `backbone`, so enriching the backbone was sufficient. Stops that are themselves on the backbone would report `≈+0 km`, which reads like a suspiciously good deal rather than "this one *is* the route", so they now show an "On route" chip instead (new `onRoute` prop).
  - Covered by: a new `src/lib/exploreCandidateActions.test.ts` (9 tests — within-tier swaps both directions; promote into the tier above and demote into the tier below from a tier edge; crossing into an *empty* tier without producing `NaN` from `Math.max(...[])`; both genuinely-immovable end positions; an unknown stop id; and a promote→demote round-trip landing back in the original tier); 2 new `e2e/explore.spec.ts` tests (a sole-occupant stop's up-arrow is enabled, promoting it flips `priority` to `must-see` in Firestore, it then renders the "On route" chip, and demoting returns it — plus an assertion that exactly the two end positions are disabled while their opposite arrows stay enabled). Full suite: 58 frontend unit tests (was 49), 228 backend tests, 76 e2e tests (was 74).

- [x] **Remaining code-review follow-ups** (2026-08-02, "Go ahead with the other issues found") — everything the first full review turned up that wasn't already fixed in the IDOR pass, in three groups:
  - **Backend resilience.** `planMeta.status` had no expiry, so a run killed by its own 540s ceiling, an OOM or a deploy left the trip `'generating'` forever and every later generate/replan/insertRestDay/reconcile was refused — unrecoverable without a manual Firestore edit, and far more consequential than the explore-mode lock already fixed since this one gates *every* expensive write path. New `functions/src/planLock.ts`: a `planMeta.statusUpdatedAt` heartbeat (stamped on claim, at each phase, and per resolved day, so a live run keeps it fresh even across chained continuations) plus a 15-minute staleness threshold. A claim carrying **no** timestamp is treated as stale on purpose — trips already wedged before this shipped can recover; the tradeoff is a narrow window where a generation in flight *during the deploy* could be reclaimed and re-run, which costs one duplicate generation rather than a permanently bricked trip. `clearCheckpoint` was both unchunked (a raw `db.batch()` over every staged day, past the 500-op cap on a long trip) and, worse, ran *after* the real days were already committed — so its failure propagated into `generatePlan`'s catch and marked a perfectly good generation as `'error'`; now chunked and non-throwing (leftover staging docs are inert — a later run overwrites them and `loadCheckpoint` validates the settings hash anyway). `mergeTrips`/`deleteTrip` also used unchunked `db.batch()` for per-item write lists; both now use `commitInChunks`, and `PendingWrite`'s `set` variant gained optional `SetOptions` so a merge-set no longer has to bypass the chunking machinery to keep its semantics. Removed `computeMultiLegTotals` (superseded by `generatePlan` computing totals inline; called only by its own test).
  - **Data integrity.** `accountBackup.ts`'s merge could orphan every trip on the abandoned account: `signInWithCredential` genuinely must run *before* `mergeTrips` (the callable authenticates as the surviving account and merges into whoever is calling), which makes the gap between them unrecoverable — the old uid is gone and nothing can re-mint its ID token. The proof needed to finish the merge is now persisted to localStorage *before* the identity switch and drained by `completePendingGoogleLinkRedirect` on the next load, so a merge lost to a flaky connection completes on its own instead of silently costing the traveler their trips (TTL'd to the ID token's own ~1h validity rather than retrying forever against a token the backend will reject). `PlaceAutocompleteInput` kept the *previous* place's coordinates when a name was typed without picking a suggestion — the field read "Bergen" while its lat/lng still pointed at Oslo, and the map pin, route backbone, detour estimates and the stop written to Firestore all silently trusted them; the typed text now resolves through the same Places lookup a picked suggestion uses, with a staleness check so a resolution landing after further typing is discarded. `AddCorridorStopForm`/`AddCustomStopForm` captured `defaultLocation` once at mount and stay mounted between uses, so panning the map and opening the form saved the stop back at the *original* centre from a blank-looking field — both now re-seed on open.
  - **Silent failures and double-submits.** Consistent error surfacing added where a failed write previously left the UI looking untouched: corridor stop keep/reject/reorder (floating promises with no `.catch` at all), `ExploreMapScreen.commit`/`SettingsScreen.confirmGeneratePlan` (`try/finally` with no `catch` — an unhandled rejection, dialog stuck open, no feedback), `SettingsScreen.commit` (settings writes were console-only, so a failed save left the field showing a value that never persisted and the traveler generated against settings they believed they'd changed), `TripSwitcher` delete, `AddRestDay`, `RequestChangesForDay`, and `ShareTripMenu`'s clipboard (which now shows the link to copy by hand when the API is refused outright). Double-submit guards where a second tap costs real money: `PlaceCard` gained a `busy` prop wired to `DayViewScreen`'s existing `requeuing` state (each action can trigger a paid Places/Claude refill), and `OverviewMapScreen`'s change-request Submit gained both a pending guard and a blank-text guard — as did `RequestChangesForDay`, which could fire a full replan from an empty textarea. Also: keyboard access on `ExploreCandidateCard` (its primary tap-to-highlight interaction was pointer-only, unlike the equivalent `PlaceCard` pattern), real `<label>`s on `ExecutionModePrompt`'s lat/lng inputs, a Cancel on `PlaceCard`'s add-note flow (previously a dead end), and a render-time resync in `ReorderCorridorPanel` so a collaborator editing the corridor mid-review can't leave the reconcile call computed from a stale stop list.
  - **Fixed the suite's flakiest test while here.** `trip-management.spec.ts`'s delete-the-active-trip case polled a raw `page.evaluate` across the navigation that deletion triggers, dying with "Execution context was destroyed" whenever a poll landed mid-transition. Every other localStorage read in the suite already goes through `evaluateWithRetry` (added for exactly this); this one was missed. Verified with three consecutive isolated runs plus a clean full-suite run.
  - Covered by: new `functions/src/planLock.test.ts` (6 tests — fresh/slow-but-alive claims kept, quiet claims reclaimed, and the missing/unparseable-timestamp cases); a new `costGuards.test.ts` case asserting an abandoned claim is actually reclaimed and runs, with the four existing "another operation is running" tests updated to seed the heartbeat a genuinely running operation now always writes. Full suite: 234 backend tests (was 228), 58 frontend unit tests, 76 e2e.

- [x] **Map froze after selecting/promoting a stop; route never updated** (reported 2026-08-02, and confirmed by the reporter to predate the recent explore-mode work) — two independent defects in `ExploreMapScreen`, both producing the same symptom:
  1. **`candidates` was a bare `.filter()`**, so it returned a new array identity on every render. Everything downstream hangs off that identity: `routeStops` → `backbone` → `<DirectionsRoute points={backbone}>`, whose effect lists `points` in its deps. The effect therefore re-ran on every render, issued a Google Directions request, and setting the result re-rendered — producing a fresh array again. A self-sustaining loop, one billable Directions request per iteration, which also explains the route never settling: each request was cancelled by the next render's cleanup. Fixed by memoising `candidates` on `corridorStops` (state-backed, so stable). Audited `OverviewMapScreen` and `DayViewScreen` for the same pattern — both already derive from state-backed hooks and were fine.
  2. **`MapPanner` called `map.panTo` during render**, and all three map screens carried their own near-copy of it. Panning is a side effect: it moves the camera, the camera-changed handler stores the new centre, that re-renders, and the render pans again — pinning the camera to the selection. Replaced all three with one `src/components/MapPanner.tsx` that pans from an effect keyed on the lat/lng **numbers**; keying on the target object would reintroduce the loop through the effect, since callers pass a fresh `{lat, lng}` literal each render.
  - Also guarded both screens' `onCameraChanged`: it fires every frame of a drag with a fresh centre object, so storing it unconditionally re-rendered the screen and its whole list per frame.
  - Covered by `src/components/MapPanner.test.tsx` (4 tests, including the exact regression: re-rendering with an equal-but-newly-allocated target must not re-pan) — verified to fail against the pre-fix component before being kept.
  - **Correction worth recording:** the first diagnosis blamed a recently-added `setCenter` for making a latent `MapPanner` bug fatal. The reporter pointed out the freeze predated that change, and re-examining found the un-memoised `candidates` chain — the actual root cause, and the one that fires paid API calls. The `MapPanner` fix is still correct and still needed; it was not the whole story.

- [x] **Architecture sections refreshed to match the code** (2026-08-02) — Sections 3/4/7 had drifted far enough to mislead. Section 3's diagram showed a single linear "client → planRequests → generatePlan" flow with no mention of explore mode, the callable surface, checkpointing/chaining, the lock model, Overpass, or the fact that callables bypass `firestore.rules` and must authorize themselves; it now describes both Map-tab modes, both backend entry paths (and why explore mode is deliberately NOT routed through `planRequests`), and the real generation flow including staging and continuation. Section 4 was missing `corridorStops`, `generationStaging`, `users/{uid}/trips`, `shareCodes`, and most of `planMeta`, and still documented `dayId = "2026-07-14"` — actively wrong since the phase-2a auto-ID migration, and exactly the kind of stale detail that misleads a reader into re-introducing a fixed bug. Section 7 gained explore mode, the two generate buttons, and trip management/account backup. No code changed; this is documentation catching up.

- [x] **Second review pass: three findings, all from the first pass's own follow-ups** (2026-08-02)
  - **`hasRoute` was reopened by the fix that came after it.** `PlaceAutocompleteInput` now accepts a typed name immediately and resolves its coordinates asynchronously (the mismatched-coordinates fix), writing `{ name, lat: 0, lng: 0 }` in between — but `hasRoute` only ever checked the *names*, so a named point still sitting on the `(0,0)` sentinel passed the guard and put the Gulf of Guinea back on the route. `validateRoute.ts` now requires each point to be genuinely located (named **and** not on the sentinel), with 4 more unit tests; the message at all three call sites became "Set a start and finish point above first — pick each from the suggestions so we can place it on the map," since "set a point" is confusing advice to someone who can see the name they typed sitting in the field.
  - **Trip Setup could show permanently stale settings, and refuse to generate because of them.** `SettingsScreen` reads `trip.settings` into local state once per mount and, before this, only re-read it on a trip *switch*. With Firestore's persistent local cache the first snapshot after a page load comes off disk, so a trip edited on another device — or simply written after that cache entry was last refreshed — rendered from the stale copy and stayed stale for the whole session, because the newer server snapshot only updated the prop. Invisible in the text fields (the cached copy usually had the right *names*) but not in the coordinates: the new `hasRoute` correctly refused to generate on a trip whose stored route was perfectly valid. New `src/lib/mergeRemoteSettings.ts` folds each arriving server copy in field by field, leaving anything edited in this mount alone (adopting the echo of an in-flight write would drop keystrokes) and returning the same object when nothing differs, so it costs no render. 6 unit tests. Found by an e2e failure that looked like flakiness — it was a real race, and the "flaky" test was right.
  - **The missing-secret bug now has a static test, not just a behavioural one.** `functions/src/secretsDeclaration.test.ts` walks the real import graph from every deployed entry point, collects the secrets reachable through its transitive imports, and asserts each one is declared — the check nothing else could make, since a file's own imports look complete, `tsc` and eslint see a valid program, and the unit tests mock the layer that would have failed. Verified against the original bug: dropping `googlePlacesApiKey` from `generateExploreHighlights` fails it with exactly that secret named.

- [x] **"Add stop" reported a failure on a search that had actually worked** (reported 2026-08-02 with a screenshot — "Could not search right now — please try again" in the Describe-it panel, with the note "But it did find a place") — the Firebase **client** SDK abandons a callable after 70 seconds by default, and the client hanging up doesn't cancel the function. Every Claude-backed callable here declares `timeoutSeconds: 180` server-side precisely because a run with a retry plus a round of geocoding can take longer than a minute, so the client was quietly the stricter of the two limits: past 70s the traveler got an error while the search went on to succeed and write its stops. Worse than a cosmetic wrong message — the obvious response is to retry, spending a second Claude call on a search that had already worked, and the stops it did find look like they came from nowhere. New `src/lib/callableTimeouts.ts` sets a single `LONG_CALLABLE_TIMEOUT_MS` (190s — deliberately just past the server's own ceiling, so whichever limit fires first is the one that can explain itself) on all five 180s callables: `rescanCorridor`, `generateExploreHighlights`, `getOvernightCandidates`, `refreshCountryGuide`, `previewReconcileCorridor`. `researchMoreAlternatives` is left alone — it has no server-side override, so the client's 70s default is already the looser of the two.

- [x] **Promote/demote moves a whole category, not one position** (requested 2026-08-02 — "Denoting/promoting cards in overview mode should move them a full category, not just one step up/down") — the previous behaviour treated the three tiers as one flat list and moved a stop one position through it, which meant a stop in the middle of a five-stop tier needed five taps to change category, and four of them looked like nothing had happened (the card shuffled one row under the same heading). The category is the part that carries meaning downstream — it's what the route backbone reads (`locked` + `must-see`) and what seeds the full generation — so that's what the arrows change now. Deliberate trade-off: there is no longer any way to reorder stops *within* a category, because nothing reads that order (`buildRouteBackbone` sorts geographically along the corridor; the generation groups by tier), so it was costing taps without buying anything. The stop still lands adjacent to the boundary it crossed, so the card moves the shortest visible distance and promote+demote round-trips. Arrow disabling is now purely categorical: every stop in must-see has a dead up arrow, wherever it sits in that tier.

- [x] **Country research: an editable brief, researched one section at a time, kept across trips** (requested 2026-08-02 — "I think this 'note' should be shown and edited in app. I also want to categorize the current note into sections so you can add just one new item to research, and it won't trigger a full rescan of the previous. I also want the country information saved across trips")
  - **What it replaces.** The old prompt asked Claude for six fixed topics in one call and stored the answer as a single `trips/{id}/countries/{code}` document with one `generatedAt`. The shape *was* the schema, so the six topics were unaddable-to by construction, "Refresh info" always re-ran all six, and the whole thing was per trip — a new trip re-researched Norway from scratch. None of the brief was visible in the app, let alone editable.
  - **The brief is now data, and it's yours.** `users/{uid}/preferences/countryBrief` holds an ordered list of `{ id, title, brief, dependsOnVehicle }`, defaulting to the same six topics (`shared/src/countryBrief.ts`). The country screen shows each section's actual question under "What gets asked", and lets you edit it, remove it, or add a new one. One list for every country, as asked: a research item is nearly always about how *this* traveler travels, not about one country.
  - **One section, one call, one document.** `researchCountrySections` takes the section ids to research and does exactly those — concurrently, each separately fallible, so one bad web search leaves the others written and reports which failed. Adding a seventh item costs one section's worth of Claude and cannot disturb the six already answered, because they are not inputs to it.
  - **Kept across trips, without serving the wrong answer.** Research lives in a top-level `countryGuideSections` collection whose document ID encodes country + section + brief hash + (for vehicle-dependent sections) the vehicle. So: camping rules researched on one trip show up instantly on the next; changing the RV re-researches clearances, weight-banded speed limits and length-banded ferry tiers and *only* those; and editing a section's question gets its own entry rather than overwriting the one other travelers share. Readable by any signed-in user, writable by no client — the callable is the only thing that has actually done the research.
  - Also re-points `getOvernightCandidates` (the one other consumer of country data) at the new store, and drops the now-dead whole-guide callable, prompt and schema.
  - Covered by: 11 unit tests on the key rules (a country-level section shares one entry across vehicles; a vehicle-dependent one doesn't; an edited brief separates; the title doesn't); 6 functions tests (only the asked-for sections are researched — one id in, one Claude call out; storage lands where a second trip will find it; a custom section from the account's brief is researchable; an unknown section is refused; a partial failure keeps what succeeded); 5 rules tests (any signed-in user may read research, no client may write it, signed-out may not read; a traveler owns their brief and cannot read anyone else's); and 4 e2e tests including research from one trip appearing on another.
  - While in here: two e2e tests were failing intermittently because they seed a route through firebase-admin and click Generate right after a reload — Firestore's persistent cache serves the previous copy of the trip first, so the click could land on a genuinely route-less trip and be correctly refused. Both now seed a recognisable trip name on the same write and wait for it, which is precisely waiting for the snapshot that carries the route. Six consecutive full runs, three before and three after, isolated the race to that and confirmed the fix.

- [x] **"Describe it" search: Google Places first, Claude only when Places can't answer** (reported 2026-08-02 with three screenshots — a search started at 10:28 still spinning, the same search failed at 10:32 with "Could not search right now", and Google Maps at 10:33 showing a dozen well-rated restaurants in that same town, with the note "there are plenty of restaurants in Hilleröd") — every typed query went to Claude with web search, which is the wrong tool for "a cozy restaurant in Hillerød": that's a lookup, not a judgement, and Google answers it in about a second. Four minutes is the client's own 190s timeout firing partway through a second Claude attempt.
  - `searchPlacesByQuery` (placesApi.ts) runs the query as a Places text search with a location bias, returning name, coordinates, country (from the place's own address components — never guessed, since the wrong one files the stop under the wrong country's guide), rating and Google's editorial summary where it has one. Coordinates come back attached, so this path also skips the per-find geocoding round-trip the Claude path needs.
  - `findStopsForQuery` (querySearch.ts) is the new front door for a typed query: Places first, and Claude only when Places returns nothing usable — either because the query described a judgement ("somewhere with a nice view about halfway") rather than a place, or because everything it found sits too far off the corridor. A Places outage falls through the same way rather than failing the search. The plain "Rescan this area" pass has no query and stays Claude's job by definition.
  - Both paths now share one `filterFindsToCorridor`, so a Places hit honours the same "along this route" / "within this radius" promise the form makes as a Claude find always has.
  - Separately, the Claude path won't *start* its retry once 100s of the budget is gone: two attempts with web search can run past the client's timeout, and a retry that cannot finish before the traveler is shown an error isn't resilience, it's just spend.
  - Covered by 7 new tests: a findable-place query is answered from Places with no Claude call at all; the "why" states the rating and review count rather than inventing prose, preferring Google's summary when present; empty Places results, a Places failure, and hits outside the radius each fall through to Claude; and one query can't drop more than 8 pins on the map.

- [x] **Name the geography the app supplies to the search prompt** (2026-08-02) — **and a correction to the entry above it.** When the Places-first change was reported still-unexplained ("There must be something else wrong, as Claude chat finds it in 2 seconds"), the first diagnosis here was that the prompt only ever sent coordinates, so the model couldn't know where "Hillerød" was. That was wrong, and the traveler said so: *"But I wrote 'City name', the input was word for word exactly like the Claude chat prompt."* They were right — a typed query reaches the model verbatim as `focusQuery`, town and all. The Hillerød timeout was the tool, not the geography: web-search grounding under a strict JSON contract, with a retry that could double the wall time. The Places-first entry above is the actual fix for it.
  - What remained true is narrower, and worth doing on its own merits: the geography the **app** supplies was still coordinates. A plain "Rescan this area" anchors on nothing but the map centre, and hard rule 1 asks the model whether a find is a small detour off a corridor described as up to 50 latitude/longitude strings. `reverseGeocodeName` (client-side, using the Maps JS API already loaded for the map itself — no new key, no new API to enable) turns the centre into "Hillerød, Denmark"; the explore screen passes its route's own stop names, in corridor order. Names when available, the coordinate form as fallback.
  - This does not weaken the "no invented geography" discipline it replaced: no coordinates are given for the model to reason numerically with, and every find is still geocoded and distance-checked server-side afterward. Naming the place is what lets the model search for somewhere real.
  - The name lookup is hard-capped at 2.5s, because it runs *before* the search it improves — and where Maps JS is unreachable, `importLibrary` doesn't reject, it waits for a script that never arrives. Caught in e2e: two corridor tests hung rather than showing their expected error banner.
  - Covered by 3 prompt tests: a named centre replaces the coordinates entirely (nothing in the payload says "latitude"), named waypoints replace the corridor's latitude list, and the coordinate fallback still works with no names.
  - Also fixes an intermittent wrong first stop in the reorder panel, found by the same runs: committed stops are ordered by their linked day's index, so before the days listener's first snapshot every stop tied on Infinity and the order fell back to whatever Firestore returned — which the panel then snapshotted into its own state. It now orders nothing until the days are known.

- [x] **Make the search measure itself, after two wrong diagnoses** (2026-08-02) — asked why the app was slow when a Claude chat turn answered the identical prompt in two seconds, the answer given was "the prompt only had coordinates" (wrong — the query carried its own town name), and then "chat used a place lookup, we used web search" — which was, at the time, inferred from a Map card in a screenshot rather than evidence. The traveler then produced the evidence: the chat's own step summary reads **"Searching for places"**. So that second explanation was right, and Places-first is the correct shape for this feature. It was still a guess when it was made, and guessing twice about a latency problem nobody had timed was the actual mistake — hence the instrumentation below, which stands regardless.
  - `logClaudeUsage` now records `elapsedMs` per attempt, beside the output tokens, web-search count and attempt number it already recorded. Those four together separate the three candidate explanations that tokens alone cannot: a slow web search, a long answer, or a silent retry.
  - `findStopsForQuery` logs `event: "query_search"` — which path answered, how long the Places leg took, total elapsed, how many places came back, and any Places error. One real search in production now says where its time went, in Cloud Logging, without anyone theorising.
  - One change that reduces latency regardless of which explanation is right: a focused query gets `max_tokens: 1500` instead of 4000. A traveler asking for a restaurant wants a handful of matches, not a survey, and output length is paid for in wall time on the call they're sitting and waiting for. The general "what's worth stopping for here" pass keeps the full budget.

- [x] **Six commits tested green and deployed nothing** (found 2026-08-02 when the traveler asked "Is this the most recent app build: 2026-08-02 03:44:37? It refuses to load any newer build") — it was the most recent *deployed* build, from commit `028b918`, and every CI run after it had failed at the same step. Retiring `refreshCountryGuide` (replaced by `researchCountrySections`) left a function deployed in the project with no source behind it, and `firebase deploy` will not delete one without confirming: *"Aborting because deletion cannot proceed in non-interactive mode."* Because Hosting, Functions and rules deploy together in one command, that aborted function deletion silently withheld the **frontend** too — so the country-research feature, the Places-first search, the prompt naming and the instrumentation were all sitting in `main`'s history, none of them live, while the app kept serving a build from hours earlier.
  - Fixed by adding `--force` to the deploy command, which is what authorises a non-interactive deletion of functions no longer in source.
  - The process failure is worth recording next to the technical one: each of those pushes was reported as "green", on the strength of a local test run, with "CI will confirm on push" and then no follow-up. The build job WAS green every time — it was the deploy job that failed, and nobody looked. Checking the run after pushing is the difference between six deploys and none.

- [x] **`main` is now the trunk, and the only thing that deploys** (2026-08-02, after mapping the trade-offs) — until today `main` held a single "Initial commit" and all 170 commits of the actual app lived on `claude/master-plan-docs-drokop`, which was also what production deployed from. Two lines in `ci.yml` were the only thing pointing there, which made a feature-branch name load-bearing infrastructure: rename or delete it and deploys stop, silently.
  - The cost was mostly paid by anyone starting fresh. A new session clones the repo and lands on the default branch — an empty scaffold — and has to be told the branch name out of band. `git diff main...HEAD` reported the whole app as new (literally "203 files changed, 47,296 insertions" during a review pass), so no diff against trunk meant anything, no PR was reviewable, and branch protection had nothing useful to protect.
  - `main` fast-forwarded to the branch (a clean ancestor, no merge commit) at the exact commit already deployed and verified, so the deploy that followed was a no-op in content.
  - The deploy job's condition is now `main` alone. CI's push trigger went the other way — **un-filtered, every branch** — because a hardcoded branch name in a trigger is precisely what rotted here; testing everything while deploying only trunk is what keeps this from recurring.

- [x] **A kept stop wears the same blue as a selected place** (requested 2026-08-02 — "Give the selected must see in overview the same blue (?) indication as selected in detailed planning") — the app already had a two-colour language for this and explore mode was the one screen not speaking it: orange for "I just tapped this to look at it", sky for "this one is in". `PlaceCard` draws a Day View place with `status: 'selected'` in `border-sky-600 ring-2 ring-sky-400`, and `MarkerBadge` already drew a **locked corridor stop's own map pin** in exactly that sky — while `ExploreCandidateCard` drew the same stop's card in emerald. So a kept stop disagreed with itself, pin versus card.
  - Corrected same day, after "I meant the circle around the pin": blue means **"this stop is in my route"**, which is `locked` OR `must-see` — the exact set `buildRouteBackbone` draws through, already computed on that screen as `routeStopIds`. Keyed on `locked` alone, promoting a stop to must-see bent the route through it while its pin still looked like an unconsidered candidate. Pin and card now share that one predicate, so the drawn route, the pin and the card can never disagree about which stops are in.
  - Covered by two e2e tests mirroring `manual-editing.spec.ts`'s own colour assertions: promoting an off-route stop to must-see turns it blue (and tapping then layers orange on top), and keeping a stop from any category turns it blue too.

- [x] **The app is private now: sign in with an invited Google account** (requested 2026-08-02 — "just writing the bare url to the app now grants you access to spending my Claude api right?") — it did. Opening the URL minted an anonymous account, a trip and a share code, and every Claude- and Places-backed button worked, so anyone who found the address could spend the owner's API budget. There was no answer to "may this person use the app at all" — only to "may they touch this trip", which is a different question.
  - `AccessGate` stands in front of every route. Nothing below it mounts, which is the point: `useTripSession` creates a trip on first load, so rendering the shell for an unrecognised visitor is what handed every passer-by an account in the first place. It says as little as possible to someone it doesn't recognise — no trip names, no counts, nothing about who the owner is.
  - The real boundary is a custom claim, not the UI. `claimAccess` is the only thing that sets it, only for an **email-verified** address on `config/allowlist`, and it reads that address from the verified token rather than from the request body — anything in `request.data` is a string the caller typed. `firestore.rules` requires `hasAccess()` on every path, and every callable calls `requireAccess()` before doing any work.
  - The allowlist is one hand-edited Firestore document (`config/allowlist`, a comma-separated `emails` field), denied to all clients both ways — reading it would expose the trusted addresses, writing it would let a caller add themselves. Adding a person is a Firebase-console edit and takes effect on their next page load. It fails **closed**: a missing document, a missing field or a Firestore outage all yield an empty list, which matches nobody.
  - Signing in **links** Google to the anonymous account when this browser is still using one, rather than signing in fresh. Trips belong to a uid; linking keeps it, so they stay where they are. A fresh sign-in on a device that owns trips would strand them behind an identity nobody uses any more. That choice is made from what the session actually is, not left to the traveler to get right.
  - `callableAccess.test.ts` enumerates the module's real exports and asserts every callable except `claimAccess` refuses a caller without the claim — a hand-maintained list is exactly what it guards against. It caught two: `createTripShareLink` and `revokeTripShareLink`, written before the gate existed.
  - The ~90 e2e specs were all written for the world before this, where opening the URL signed you in. They now call `signIn(page)`, which waits for the gate's own button first — so the migration doubles as an assertion that the app never mounts without access. The account is real (allowlist, callable, claim, token refresh, rules); only Google's own popup is stubbed, via a hook that exists solely in emulator builds. `access-gate.spec.ts` covers the gate itself, including that an unsigned visit creates no anonymous account at all.

- [x] **Family can follow the trip from home, read-only** (requested 2026-08-02 — "the goal is to be able to share the plan along with the dairy for relatives so they can 'join' our trip from home", then "include map for family") — the existing share code was the only way to hand someone a trip, and it grants full editing.
  - `/share/:token` renders outside both AppShell and the gate: no sign-in, no account, no membership, nothing that can write. The e2e proves that as an observable fact rather than a claim about the code — the guest page makes no identitytoolkit request, opens no Firestore channel, and contains zero buttons and zero inputs.
  - One `viewSharedTrip` endpoint resolves the token and reads the trip **live** on every request, so the page updates itself as the trip changes with no publish step and no second copy to drift. It polls every 30s while visible. The response is assembled field by field into its own schema rather than spread from `Trip` — `meta.shareCode` must never reach the one audience this feature exists to keep read-only.
  - The token is 32 random bytes, not the 6-character editor code: a view link gets pasted into family chat threads with no sign-in behind it, so its secrecy is the only access control it has. Server-only in the rules, per trip, revocable.
  - The map is the same route the travelers see — start, the committed stops in driving order, finish, with real driving directions — running with `disableDefaultUI` so the page keeps its "nothing to press" property rather than sprouting a fullscreen button and a Street View pegman that lead elsewhere.

- [x] **One-time setup the gate needs, and the evening it cost to find** (2026-08-03) — the login gate deployed green and locked the owner out of his own app: *"This planner is private, and hogestam@gmail.com isn't on its guest list."* The allowlist was correct the whole time. `claimAccess` was **crashing** on its last two lines, and every layer between that crash and the screen erased the evidence.
  - **Root cause, and the required console step:** Cloud Functions run as the **default compute service account** (`<project-number>-compute@developer.gserviceaccount.com`), which is *not* the account that deploys them — so deploys were green while the runtime had no permission to do the one thing `claimAccess` exists to do. Setting a custom claim is an edit to an auth user, and that account needs **Firebase Authentication Admin** (`roles/firebaseauth.admin`), granted at console.cloud.google.com/iam-admin/iam. Not in code, not in the Firebase console, and not something any deploy will tell you about. A fresh project will need it again.
  - **Why no test could have caught it:** the Auth emulator does not enforce IAM at all. All 331 backend tests exercise `setCustomUserClaims` against a server that grants everything, so the suite proves the logic and says nothing about whether production may run it. Worth remembering for anything else that calls the Admin SDK's *auth* surface.
  - **The failure that actually cost the time was diagnostic, not functional.** `AccessGate`'s status check wrapped the callable in one `try/catch` and fell through to `denied` — so a crash, a missing function, a network drop and a genuine refusal all rendered as the same sentence, and that sentence asserts something specific about the allowlist. Three diagnoses were made against it and all three went to the wrong place: an array-shaped field, then a misplaced document, then the IAM grant. Only the third was real.
  - Refusal and "couldn't ask" are now separate states: only `permission-denied` — the code `claimAccess` throws for an address it looked up and did not find — produces "not on the guest list". Everything else says the check could not be completed and prints the error code on the page, because the person hitting it is holding a phone with no console. `claimAccess` catches its own Admin SDK failures and hands back their code, which is what finally named this one: `auth/insufficient-permission`.
  - **Correction to `dcc6aae`'s commit message**, which is on `main` and says the allowlist field's *type* caused the lockout. It did not — the field was a correctly formatted string throughout. That commit was written from a guess made before the evidence existed. Reading a string or an array is still a fair thing for a hand-maintained console field to do, so the change stands; its stated justification does not.

Update 2026-08-13: the entries below cover a two-month-trip-shaped batch — the trip this app is actually being built for is now sixty days, and most of what follows is something that was fine at three days and stopped being fine at sixty. Sections 3–7 and Section 10 were corrected alongside them; where a section still described the old behaviour, the correction is noted in the entry rather than applied silently.

- [x] **Judge pacing by the whole trip, not by each day** (reported 2026-08-12 — a Helsingborg→Berlin plan that spent two of its three days 45 km from the start and then drove the rest in one go; **written twice**, the first version rejected by the trip owner) — Section 5 now carries the full design; this records how it got there.
  - **The first attempt was a per-day minimum distance**: flag any drive day covering less than half the trip's average. Rejected outright, and correctly: on a two-month trip short days and long stays are the *point*, so a rule that treats a 40 km day as a defect is wrong about the product, and gets more wrong the longer the trip. It also mis-stated the complaint. What went wrong on that trip was not that a day was short — it was that the shortness was never paid for until the end, and then all at once, which is a fact about the whole trip and not about any day in it.
  - **What replaced it** measures exactly that and nothing else: after each day, the distance still to cover against the drive days still available, versus what the trip needed to average from the outset. The ratio starts at 1.0 by construction and climbs only when days come in under average, so it is a direct read on back-loading and completely indifferent to how any individual day is spent. A slow first week balanced by a slow rest of the trip never trips it; a slow first week followed by a forced march does.
  - **Advisory, one per trip, at the worst point.** Not a gate — the trip-average gates were removed for good reason (Section 5's v1.0 note) and the traveler is the one who knows whether the stop was worth what it cost the end of the trip. One warning rather than one per day because the shape is a single fact about the trip; listing every contributing day would bury it. Written to `planMeta.pacingWarnings` by all three write paths (`generatePlan`, `replanTrip`, `corridorReconciliation`) and shown as a dismissible amber banner on the overview, keyed on the warning text so a regeneration with something new to say gets to say it.
  - **Says nothing at all below four drive days**, and requires three still remaining: below that there is no distribution to speak of, one stop legitimately *is* a third of the trip, and no ratio can tell "wasteful" apart from "that is why we came". The prompt is the only honest lever at that length — `PACING_RULES` gained a rule 6 stating the back-loading problem in terms the model can act on before committing to a low-mileage stretch.
  - **Not verified on a real plan.** It has only ever fired against crafted fixtures in `pacingValidator.test.ts`. Whether 1.4× is the right line, and whether the sentence reads as advice rather than a scolding, are open until it fires on a genuinely generated trip.
  - Leftover to clean up: `planMetaSchema.pacingWarnings`' comment and `OverviewMapScreen`'s banner comment both still describe the rejected per-day rule ("drive days that barely move the trip along"). Comments only — the behaviour is the back-loading one.

- [x] **Put the overnight stop at a campsite, not a road junction — and resolve every day's options up front** (2026-08-12, two commits that only make sense together) — a generated overnight used to be the geocode of `"Berlin, Berlin, DE"`, which is an intersection in Mitte. The pin was wrong, the "Navigate" link took you to a road, and the only way to find an actual site was to open "Change overnight" and wait.
  - **Real places.** `functions/src/overnightOptions.ts` resolves campsites (Places), stellplatz and free motorhome parking (OSM) for every day, then commits one of them as `TripDay.overnight`. `pickDefaultOvernight` prefers a *named* stellplatz — the stated preference — but falls back to a campsite before an anonymous one, because an unnamed OSM point carries no indication that the site still operates while a Places campsite comes with a rating and a review count. Free parking is offered and never chosen for you: whether you may actually sleep in one is a question about local signage and national law, not about the pin.
  - **Up front, not on demand.** The old picker resolved one day at a time, costing an Overpass request and one or two Claude web-search calls *per day opened*. Over sixty days that is not a cost question but an impossibility — a single one of those Claude calls had already taken the picker past its 180 s ceiling (two requests on 2026-08-10 sat at 179.9999 s and were killed by Cloud Run with a 504, which the client rendered as the same generic error a real failure produces; fixed separately on 2026-08-11 with a per-source deadline so one source that never answers can't take the others down). Now: options for every day, resolved at generation, stored in `days/{dayId}/overnightOptions`, and the picker is a Firestore read. **The per-day Claude call is gone entirely** — campsites come from Places the pipeline is already calling, and stellplatz/free parking from corridor-wide Overpass queries: three requests for a 60-day trip, not sixty (points are deduped to ~11 km and batched 20 to a request).
  - **Re-runnable on its own** — `refreshOvernightOptions` callable plus a "Refresh overnight stops" button on Trip Setup. Structurally safe rather than merely cheap: it reads only each day's town and writes only that day's options and committed overnight, and drive legs are measured town-to-town, so nothing it does invalidates a distance already computed. That is also why it takes no plan lock. `TripDay` gained `townAnchor` specifically for this: the overnight has now moved off the town centre, and re-anchoring the next search on it would let the search drift a little further out of town on every re-run.
  - **The stellplatz OSM filter was relaxed** from `tourism=caravan_site` + `caravan_site=motorhome_stopover` to the parent tag alone, with the sub-tag kept as a ranking signal instead. The strict filter was the OSM wiki's own definition of a stellplatz and it was discarding real sites; widening the net costs some precision, and ranking an explicitly-tagged stopover above a bare caravan site at similar distance is where that cost is paid back.
  - **Never run against live OSM.** The development sandbox blocks `overpass-api.de`, so the corridor query, the relaxed filter and the batching are tested only against mocked responses (`overpassApi.test.ts`). The query shape, the tag set and the dedupe/batch arithmetic are all unverified against the real endpoint — including whether a ~80-clause query is one Overpass actually answers in practice rather than in principle.
  - **Deliberately not built**: wild camping as a *mapped* option. OSM does not map it — nobody surveys a field — so the free option offered here is parking a motorhome is explicitly allowed to use, which is the thing that actually has coordinates. Whether a country lets you sleep in one stays prose in the country guide's free-camping section.

- [x] **Stop generation throwing away the traveler's own curation** (2026-08-12) — two related defects that between them made curation feel unreliable in a way nobody could quite pin down.
  - **`writeGeneratedDays` deleted every corridor stop.** Harmless while candidates were consumed at generation; destructive once they were durable. The first generation wiped the entire "worth a detour, but not this time" set — every researched candidate, every rescan find, every hand-dropped pin — with no way back short of paying Claude to research it all again. Now only `committed` stops are deleted (they describe the plan being replaced and are rebuilt from the new days); everything else survives. This also makes generation consistent with `replanTrip`, which had always deleted only the stops linked to days it was actually replacing. A preserved stop the new plan now routes through is deleted as a duplicate, matched on name or proximity — a candidate's coordinates come from the highlights geocode and the day's from its own, so the two land a street apart rather than identical.
  - **`kind: 'full'` ignored curation entirely.** The two "Generate full plan" buttons behaved completely differently for no reason a traveler could see: committing from the explore map honoured every vote, keep and rejection, while the button on Trip Setup re-ran Claude's curation phase from scratch and silently discarded all of it — and then `writeGeneratedDays` deleted the evidence. Both paths now seed from the traveler's curated stops whenever there are any. The remaining difference is only what happens with none: `full` researches the trip from nothing, which is exactly right for a trip nobody has explored yet, while an explore commit with an empty corridor is a mistake worth reporting.

- [x] **Order explore by route, and put interest on the card** (2026-08-12) — the candidate list was three sections, one per priority tier, with up/down arrows to move a card between them. That answered "which of these does the app think are best", which the card already says, and made the question the traveler actually had — where does this sit relative to the others, is it before or after Hamburg — one they had to reconstruct by cross-referencing three lists against the map. The list is now sorted along the corridor (`sortAlongRoute`, `shared/src/geo.ts`, extracted from `buildRouteBackbone`'s own middle-point ordering so the two cannot disagree), and interest is a three-way selector on the card. The arrows went with the grouping they existed to serve: in route order a vote no longer moves the card at all, only repaints it, and an arrow that changes a value you cannot see is a worse control than a switch showing it. `rank` is no longer written — it only ever ordered stops within a tier, and nothing reads that order (the backbone sorts geographically, the generation groups by tier). Section 7.2 and Section 3 updated; both had described the tiered list.

- [x] **Keep the curation Claude finished when it fumbles the last line** (production failure 2026-08-12, trip "Luxemburg") — 5,609 characters of otherwise-complete curation were discarded because the final candidate ended `"why "` with no value. `JSON.parse` is all-or-nothing, so both attempts failed identically and the callable 500'd after paying for two Claude calls. Not a freak: the 30-day usage log showed 4 of 12 highlights runs needing their retry, so a run where *both* attempts miss is simply the tail of a rate the code already lived with. `salvageJsonPrefix` cuts a broken response back to the longest prefix that is valid JSON and closes whatever containers are still open, tracking string/escape state so a brace inside a `why` sentence is never mistaken for structure. It only ever truncates at a boundary the model itself closed, so nothing is invented, and the result is still validated against the real schema.
  - **Scoped to the curation call on purpose**, which is the whole design decision here. A shortened candidate list is a valid answer — the highlights schema deliberately allows any number of regions and candidates — so the worst case costs the traveler the last town. A truncated route outline would silently shorten a trip and a truncated day chunk would leave a day empty, so the outline and detail calls still fail loudly. Salvage everywhere would have been the obvious generalisation and the wrong one.

- [x] **Let trip setup name any country, not just the sixteen on the chips** (reported 2026-08-13 with a screenshot of a trip literally named "Luxemburg") — the preferred-countries chips were the only countries choosable at all, so a trip whose destination wasn't among them had no way to say so. A search box over the full ISO 3166-1 set now sits under the chips; picking a result appends a chip that looks and deselects exactly like the presets. Deliberately a closed vocabulary rather than the free-text entry the interests chips use: `tripSettingsSchema` requires two-letter codes and a rejected settings write doesn't fail loudly on the client — it fails on the next read of the trip document, i.e. the trip stops working. Only the alpha-2 code is stored, so the flag renderer, the Countries tab and the settings JSON handed to Claude cannot tell a searched country from a preset one. The list is held as a literal rather than read from `Intl` at runtime, because ICU data differs between browsers and Node versions and a list whose labels shift under it can't be searched or tested deterministically.

- [x] **Add a deploy workflow, so releasing stops depending on one laptop** (2026-08-10) — there was no on-demand deploy path in the repo at all: CI deployed on a push to `main`, and anything else was a `firebase deploy` from somebody's machine. That is why fixes sat on `main` while the bugs they fixed were still being re-reported from the phone. `.github/workflows/deploy.yml` is manual-dispatch only, with a target picker (hosting / functions / rules / all) — deliberately not automatic, because a deploy changes what travelers are using mid-trip and that is a decision someone makes rather than a side effect of merging. It fails early and by name if the production web config repository variables are missing, since a bundle built with the wrong values loads and then fails to authenticate anyone, which looks like an outage rather than a misconfiguration. Section 1's locked-decisions row and Section 10's last line both claimed deploys were fully automatic from `main` or the working branch; both corrected.

### In flight — agreed direction, NOT yet landed

- [ ] **Sights lead the route, instead of towns leading it** (agreed 2026-08-12; not built) — curation today answers "which towns are worth sleeping in" (Section 6.1 phase 1 returns candidate overnight *towns*). It is being changed to answer "what shouldn't we miss": sights and activities matched to the stated interests and the freeform notes, each carrying a base town to sleep in and a time-needed estimate that feeds pacing, with the outline phase sequencing *sights* and deriving the overnights from them.
  - The gentler option — keep towns as the unit, but have each one list the sights that justify it — was put up and explicitly turned down. It would have been a smaller change and it would have left the actual ordering decision where it is now, on towns, with sights as after-the-fact justification. The point of the change is that the thing being sequenced should be the thing the trip is for.
  - Consequences to plan for, not yet designed: `corridorStops` currently models a place to sleep, and a sight is not one; the time-needed estimate is a new input to pacing, which today only knows about driving; and every existing trip's curation is town-shaped, so there is a migration or a compatibility story to write.

- [ ] **"Generate overview" must stop wiping curation** (agreed 2026-08-12; not built) — `generateExploreHighlights` deletes every existing `candidate` stop before writing its fresh pass (`buildExploreCandidateWrites` takes the existing refs precisely to delete them). `locked` stops already survive, which was enough when candidates were consumed at generation and are re-findable for free. It is not enough now that they are durable, carry a traveler-set interest level, and survive generation itself (see the curation entry above) — this is the one remaining path that still destroys them, and it is the button whose whole promise is "cheap and repeatable".

- [ ] **Let the planner choose the overnight type, free camping included** (agreed 2026-08-12; not built) — `pickDefaultOvernight` today prefers a named stellplatz, falls back to a campsite, and never chooses a free spot for you. The change: let the plan choose the type per night, free camping included, wherever the country's own cached free-camping rules (`countryGuideSections`) allow it — with an **off-grid tolerance** (default 3 consecutive free nights) after which a serviced stop is forced. The constraint being modelled is fresh and waste water capacity, not preference: the tank is what ends a run of free nights, and a traveler who wants four in a row is asking a question about their RV rather than about their taste. Needs a settings field, a rule the pass can read per country rather than per trip, and a way for the picker to explain *why* a given night is serviced.

### Agreed direction, not yet started

- [x] **Route eagerly, detail lazily** (agreed 2026-08-12; built 2026-08-16) — generation no longer produces activities and restaurants for every day up front. The route is still solved for the whole trip; detail is a rolling window (3 days by default, set per trip — see below) resolved by the `detailDays` callable when a day is opened. `TripDay.detailStatus` carries the state, with a heartbeat and a durable `detailError` — absent means ready, so every trip planned before this is untouched. Generation and replan both detail only the first window. NOT done, deliberately: the segmented-generation machinery below is now rarely needed but still correct, and removing it is its own change; the window does not follow position, per the note below.
  - **The route stays whole-trip.** Towns, dates and drive legs are a global constraint problem — where you sleep on day 12 depends on everything before and after it — and they are cheap: one outline call plus per-day Places/Routes resolution. Nothing about that improves by deferring it.
  - **Detail becomes a rolling 3-day window**, resolved when a day is opened, plus a "prepare the next N days" button.
  - **The window is the traveler's, not ours** (2026-08-17, "I want the option to decide how many days ahead it should plan as a slider in trip setup"). Three was a guess about how the app gets used, and it is the kind of guess only the person on the trip can settle: someone booking restaurants a week out and someone improvising tomorrow want different numbers and neither is wrong. `TripSettings.detailWindowDays` (1–`MAX_DETAIL_WINDOW_DAYS`, read through `detailWindowDaysOf` which applies the default and clamps — it sizes paid work and arrives from a client write) drives all three places the old constant did: the eager window at generation, the eager window on a replan, and the rolling window the `detailDays` callable fills in. The client sends no count at all, so the two windows cannot drift apart. Capped at two weeks rather than "the whole trip", because past that the window stops being a window and becomes the thing this split was built to stop.
  - **It is named for what it controls.** It shipped as "Plan ahead", and on a six-day trip set to 2 it produced a full six-day route — reported the same evening as "Asked to plan 2 days. Got all." The behaviour was right and the label was not. The route cannot be partial: a trip has a fixed finish on a fixed date, so where you sleep on night one is decided by how far there is left to go and how many days remain (`validatePacing` runs over the whole day list; the outline prompt requires day 1 at `startPoint` and the last day at `endPoint`). Two days of route have nothing to compute that from. What is genuinely per-day, and genuinely expensive, is each day's activities and restaurants — one Claude call per chunk plus Places lookups for 5 activities and 9 restaurants — against ONE whole-trip outline call for the route. So the label is "Activities & food filled in: N days ahead", and the hint opens with the whole trip being routed rather than mentioning it second.
  - **Changing it does not send a finished plan stale.** Every other setting edit does, correctly — a new finish point means the days that exist were built against something untrue. This one is not like that: the lazy path applies the new number immediately and the eager one at the next generation, so marking the trip stale would put "Re-plan trip" in front of someone who moved a slider and ask them to pay for something they already have. `NON_INVALIDATING_SETTINGS` in `src/lib/detailWindow.ts` is the exception list, and it has exactly one member.
  - **The saving is mostly not on first generation.** It is on every *replan*, which today re-details the entire remainder of the trip — on a sixty-day trip, from day 5, that is fifty-five days of activities and restaurants regenerated to change one week. With a window, the days beyond it have no detail to throw away, so a replan costs the route plus at most the window.
  - **Position-following was considered and deferred.** The execution-mode geolocation check (Section 7.4) already knows where the RV is, so the window could follow it automatically. Held back in favour of an explicit button until the calendar drift is known: a trip that runs two days behind would have the window silently detailing the wrong days, and guessing at that before there is a real trip to measure is how the last few latency diagnoses went wrong.
  - **It also makes the segmented-generation machinery largely redundant** — `GENERATION_TIME_BUDGET_MS`, the continuation chaining, most of the per-day staging. All of it exists to survive the day-detail phase inside a 540 s ceiling, and that phase leaves generation. Not a reason to do this, but a reason not to invest further in that machinery in the meantime, and something to remove deliberately rather than leave as dead weight.

### Audited 2026-08-17 — failures reported as facts about the world

A pass over the whole codebase for the pattern behind most of this week's
reports: the app describing its own failure as something true about the
trip. "Nothing new found nearby" (the interests were never sent), a bike
park named after the wrong village (the verified name was discarded),
"outside the area searched — zoom out" (a silent cap, and advice that made it
worse), "none could be found on the map" (the map was never asked). All four
are the same shape.

Fixed in that pass:
- A Places lookup that THREW was counted as a place that does not exist, in
  both the rescan and curation paths. Total failure now surfaces the real
  cause; "Places answered no" stays a result; a single flaky lookup still
  degrades.
- `computeRouteLeg`'s haversine fallback produced distances and times
  indistinguishable from measured ones, which also fed pacing validation.
  Legs are marked `estimated` and the day says so.
- `exploreStatusUpdatedAt` was a start timestamp read as a liveness signal —
  the third instance of that bug. It is a real heartbeat now, like the rescan
  and day-detail locks.
- The rescan's search area is drawn on the map (`SearchAreaCircle`) instead
  of being described, and the cap rose from 50 km to 150: what set it at 50
  was web-search cost, and this path no longer uses web search.

Added later the same day, from a report of "Could not find stops right now —
please try again." on a trip already back at `idle`:

That sentence turns out to be reachable by exactly one route. Every failure
the callable itself raises carries a written message, so the generic line is
what the app says when the rejection carried **no server account at all** —
and `@firebase/functions` produces precisely that (`internal` / `"internal"`,
via `postJSON`'s `status: 0`) for a fetch that never completed. Its own source
comment says the browser cannot tell a network drop from a backend that
crashed before setting the CORS header. So the message was, at best, unfounded
advice: the run it describes may have been alive, may have finished, may have
failed for a reason nobody could see. There was no way to find out afterwards,
because this path — unlike the rescan path since 2026-08-16 — recorded
nothing.

- `planMeta.exploreLastError` / `exploreLastFailedAt`: the cause, written
  where it outlives the request, in the exact words the caller would have been
  given. Cleared by a run that works; not written by the busy guard, which is
  a button press colliding with a healthy run rather than a failure.
- The two screens that fire the search stop letting the socket decide.
  `exploreFailureMessage` reads the trip instead: still generating → say the
  search is running and its finds will arrive on their own; finished →
  say so, because a search that succeeded unwatched is the likeliest outcome
  of a phone locking mid-call and "try again" would charge for it twice;
  failed → say what broke. The generic line is now the last resort rather
  than the only answer.
- Which run those signals belong to is decided by comparing the trip against
  itself before and after the attempt, not by comparing a server timestamp to
  a phone's clock.
- `generateExploreHighlightsForTrip`'s `finally` no longer throws over the
  error on its way out: a trip deleted mid-run used to replace "Claude
  returned unparseable JSON" with "no document to update".

And again that evening, from a Copenhagen–München trip whose curation came
back completely empty, shown as "Nothing stood out along this route — for a
short or local trip, that can be the honest answer." It is 1,300 km.

The cause was the countries-first rewrite two entries above, overshooting. It
fixed a chosen country being quietly dropped for sitting "off the corridor" —
but it did so by making `preferredCountries` **the scope** of the research,
with the start-to-finish corridor demoted to a fallback used "if
preferredCountries is empty, and only then". That reading is a ceiling, and
the country list is routinely stale in exactly the way that makes a ceiling
catastrophic: `startNewTrip` carries the previous trip's country list over
while deliberately NOT carrying its start and finish points, so a new trip
begins with a list describing the *last* trip's route. A list naming Sweden
and the Baltics, over a route through Denmark and Germany, meant the ground
the trip actually drives across was out of scope — and an empty answer was the
faithful execution of that instruction.

- The prompt now names two sets of countries, neither limiting the other: the
  ones the trip travels through (always in scope, on every trip), and the
  chosen ones (each researched on its own merits, as before). Stated
  outright: `preferredCountries` is a floor, never a ceiling, and it is
  expected to be out of date.
- The "an empty answer is honest" licence is scoped to what it was written
  for — an afternoon in one valley — and explicitly withheld from a trip that
  crosses countries.
- `planMeta.exploreLastEmptyCountries`, for the same reason
  `exploreLastRunAt` exists: the explanation was computed, returned through
  the callable, and then dropped, because "Generate overview" navigates to
  the map on success and the screen holding it unmounts on the way. The map
  reads it off the trip now, names the countries that came back empty, and
  points at the country list as the thing to check.

One more the same week, from a screenshot of a card headed "Bruzaholms
Gokart" — Google's own listing calls it a Gokartbana — carrying a description
of a lift-free downhill and enduro trail network, filed under "mountain
biking". Nothing had gone wrong with the description. Curation proposed a
mountain-bike spot in Bruzaholm; Places was asked for it and answered with
the best-known business in that village sharing its name; the name check said
yes.

The arithmetic was the whole story. `nameLooksRight` required half the
requested name's identifying words with a floor of one, so a TWO-word name
needed ONE match — and "place + category" is the commonest shape a sight name
takes. The place name alone satisfied it, leaving the category word, the only
word that says what the thing IS, free to be anything at all.

No string rule separates "Kronborg Slot" → "Kronborg Castle" (right, a
translation) from "Bruzaholms MTB" → "Bruzaholms Gokart" (wrong, a different
sport): both share one word and differ in one. The missing signal is that
slot and castle mean the same thing and MTB and gokart do not. So:

- `CATEGORY_GROUPS`, a small explicit table of category words across the
  languages this corridor actually uses, read in two directions — as
  equivalence, so a translated category still matches, and as **conflict**,
  so two stated, different categories reject outright regardless of word
  count. Silence is not disagreement: a result naming no category
  contradicts nothing. Compounds are read by substring, because
  "Bergscykelpark" and "Gokartbana" are one token each.
- The threshold is every word for a name of one or two, and all-but-one
  beyond that. Two words no longer means "the place name will do".
- Nordic genitive `-s` is matched across ("Lunds Domkyrka" is listed as
  "Lund Cathedral"). Found while fixing the above, and it only ever loosens
  — it recovers candidates that were being dropped, and the category check
  still refuses a different kind of place.

Also that day, requested: pins coloured by interest level — green must-see,
amber worth-a-detour, red if-convenient, repainting when the level changes.
The pin reads the level off the same live `corridorStops` document the card
writes to, so there is nothing to keep in sync. Tap-to-view (orange) and
in-my-route (blue) still win: a pin that stopped answering taps because it
was green would be a worse map. A key sits under the map, because colour is
only information once the reader is told what it means.

Requested the same evening: "Let's get a picture similar to activities to the
overview plan as well." The photo was never missing from the data. The text
search that verifies a curated sight already asks for `places.photos`, and
`mapRawPlace` already builds the media URL — `verifyPlaceLocation` was
dropping it on the floor, exactly the way it used to drop the verified name
and the listing URL. So it is carried through `VerifiedPlace` →
`RegionHighlightCandidate` → `corridorStop.photoUrl` on both curation paths
(highlights and rescan), and the reverse direction too, so committing to a
full plan does not strip it back off.

Drawn full-bleed at the top of the card, the way `PlaceCard` has drawn one
for every activity and restaurant since the day-by-day plan existed — the
explore list is where the traveler actually decides whether a place is worth
driving hours for, and it was the one screen with nothing to look at. No
placeholder where there is no photo: `PlaceCard` shows a camera glyph because
its cards sit in a grid that a missing image would break, whereas here it
would be a grey band on every unphotographed stop.

This reverses a deliberate earlier choice, which said so in the card's own
comment: "Places photo media is billed per load and puts the API key in a
scrapeable `<img src>`, whereas a link costs nothing". Both halves are still
true and neither is new — the day-by-day plan has shipped that exposure since
PlaceCard existed.

Worth being exact, because the first version of this note was not: the
curation search returns only the photo's REFERENCE. The bytes come from a
separate Place Photo request the browser makes when the `<img>` is rendered,
carrying the API key in the query string. So a photo costs a request the
first time a card is scrolled to (browser cache absorbs the rest), rather
than being something the search already paid for.

Two things follow. `loading="lazy"` is load-bearing, not decoration — a
corridor is routinely twenty-five cards. And the volume genuinely changes:
before this, the only `<img>` carrying a Places photo URL was in `PlaceCard`,
reached solely from Day View and the shared-trip view, i.e. only once a full
plan exists. Explore mode is where the time is actually spent, so anyone
whose billing showed nothing for photos may simply not have been generating
plans. The key's HTTP-referrer restriction is the real mitigation for the
other half and remains outstanding.

Exact SKU and free-allowance figures deliberately not recorded here: they
could not be verified from the build environment (egress to
developers.google.com is blocked), and a number written down from memory is
worse than a pointer to the Cloud Console billing report grouped by SKU.

Two follow-ups on 2026-08-18.

**Photos load eagerly** ("So just implement full photo loading"). `lazy` was
the cautious default while the per-request cost was unverified; the cost is
the owner's call and they made it. `decoding="async"` stays, so fetching the
images never blocks the list itself from painting. The comment that justified
the caution was also corrected — it claimed the curation search "already paid
for" the photo, and it had not: the search returns the photo REFERENCE, and
the bytes are a separate Place Photo request the browser makes per image.

**"Could not research that right now — please try again."** — the same
pattern, on the third screen, reported from the Countries tab with Germany's
four sections unresearched. Fixed the same way, and this time the shared part
was extracted rather than copied a third time:

- `src/lib/callableError.ts` — `serverAuthoredMessage` (the codes our own
  callables raise, minus the ones whose "message" is just the code repeated
  back) and `isDeadlineExceeded`. The explore search now reads from it too.
- `deadline-exceeded` gets advice that can work. Researching runs one
  web-search-backed Claude call per section, ALL AT ONCE, against the
  function's own 180s ceiling — so "Research 4 missing" is four of them racing
  one clock, and pressing it again asks for the identical race. The message
  names the lever: one section at a time.
- Per-section failures now carry their cause out.
  `researchCountrySectionsForTrip` caught each one, logged it, and returned
  the bare section id, so "Could not research 4 of 4" was the most that could
  ever be said. `failureReasons` is returned alongside `failed` (added rather
  than replacing it, since a PWA can be running an older client), and the
  screen names one distinct cause or summarises several.
- `generateCountrySection`'s retry loop logged nothing at all — a failed first
  attempt was invisible, so even the server logs showed only whichever error
  came last. It says which attempt hit what now, which matters on the one path
  whose answers can contain "the search tool was unavailable".

### 2026-08-19 — committing to a stop stopped being the way to lose it

Asked: "Will changing trip dates/departure town try to keep the already
derived plan somehow? I'm trying to find ways to not accidentally lose
already researched data."

Changing a setting deletes nothing — it marks a ready plan `stale`. The loss,
if any, happens at the button afterwards, and there are two very different
ones both called some form of "re-plan":

| | Trip Setup's stale button | GPS banner "Re-plan" / "Request changes" |
|---|---|---|
| kind | `'full'` | `'replan'` |
| Days | **all** deleted and rebuilt | only days from today forward |
| Corridor stops | deletes `committed` | deletes only stops linked to replaced days |

Diary (`trips/{id}/log`, a sibling of `days`), notes, and country research
(a top-level collection, deliberately outside the trip) survive both.

**The hole.** `committed` says "this is in the itinerary", not where the stop
came from — and the traveler's own stops end up there too, via Lock in → Add
to route (`corridorReconciliation`). A full regeneration deleted every
committed stop and seeded only from `candidate`/`locked`, so **committing to
a sight made it less likely to appear in the next plan than leaving it in the
list would have.** Precisely backwards.

The literal fix I first proposed — put `committed` in the seed query — turned
out to be wrong, and checking before changing is what caught it: most
committed stops are the **overnight towns generation mints itself**
(`buildCorridorStopWrites`), and seeding those would quietly pin every
rebuild to the route it was replacing. Worse, a hand-dropped pin writes
exactly the fields one of those towns does — name, coordinates, country,
why — so no field-sniffing can separate them.

So `corridorStop.origin` records it explicitly: `'traveler'` for curation,
rescan finds and hand-dropped pins; `'plan'` for generation's own overnight
towns. Then:

- A committed stop with `origin: 'traveler'` is **returned to `locked`** with
  its day links cleared, rather than deleted — still curation, ready for the
  plan about to be written.
- It is also **seeded** into that plan, so it is proposed again rather than
  surviving as a pin nobody offered.
- Generation's own stops are still deleted, and still excluded from the seed.
- **Absent origin reads as `'plan'`.** Every stop written before the field
  existed carries none, and this gates a deletion — the conservative reading
  keeps existing trips behaving exactly as they did rather than resurrecting
  stops nobody asked to keep.

And the naming, which was its own trap: the stale-plan button is **"Rebuild
plan"** now, not "Re-plan trip", and its dialog says what actually goes (the
activities, restaurants and overnight stops you chose), what stays (your
researched stops, with locked ones handed to the new plan), and points at
"Request changes" as the non-destructive route.

### 2026-08-19 — drift measured in days, and interests stopped invalidating

Two asked for together: "I'd also like for adding an interest to not flag the
plan as stale" and "check for an option to dynamically replan based on gps
position. How is a drift in the plan handled. If you for instance are one day
behind, how is this taken care of?"

**Interests joined `NON_INVALIDATING_SETTINGS`**, for a different reason from
the detail window already there. An interest is not a constraint the existing
days were built against — it is a preference for what to LOOK FOR next.
Adding "hot springs" does not make yesterday's route wrong; it makes the next
rescan, the next "Find more stops" and any re-plan search for hot springs.
Notes already behaved this way (NotesScreen writes them without going through
`updateTripSettings` at all), so this also makes the two halves of "what
should we look for" agree with each other.

**The drift check was answering a different question from the one asked.** It
existed and worked — `useExecutionMode` polls geolocation on mount and every
30 minutes while today is inside the trip's dates, and `replanTrip` already
had the good part: a replan triggered by falling behind is told to make the
FIRST day easy and spread the catch-up across the remainder, never to stretch
today. But what it measured was straight-line distance from here to TONIGHT'S
overnight town, over a flat 50 km. Three faults:

- **No sign.** Parking 60 km PAST tonight's town — comfortably ahead —
  measured exactly like stopping 60 km short of it, so a good day was as
  likely to raise the banner as a bad one.
- **No units anyone plans in.** "One day behind" was unanswerable: 60 km on a
  slow, sight-heavy stretch IS a day, while 180 km on a transit day is an
  afternoon.
- **Blind to the trip.** One threshold for a 200 km week and a 4,000 km
  month.

`src/lib/planDrift.ts` measures progress ALONG the planned route instead —
projecting the current position onto the polyline of overnight points, so
halfway between two nights reads as halfway rather than as "at the nearer
town" — compares it to where the plan says tonight ends, and converts the gap
into days using the pace of the days that are LEFT (which is where catching
up actually happens). The banner leads with days and keeps the kilometres as
evidence. Prompting needs both gates: far enough absolutely AND relative to
the trip's own pace. Being ahead never prompts, and a negative gap is never
sent to the replan as `behindScheduleKm`.

Straight-line × `ROAD_DISTANCE_FACTOR` throughout, deliberately: this decides
whether to ASK a question, not what to do about it. The replan measures
properly.

Known and deliberate: on the final night there is no remaining pace, so the
gap cannot be expressed in days and it falls back to the absolute distance.

### 2026-08-19 — the overview stopped disappearing when planning started

Reported: "I'm not happy with how the overview is gone after the plan is
done. We discussed maintaining that portion into the full plan. It needed to
merge more. As we moved into detailed planning, the previously researched
thing just look boring and can only be removed, so the whole functionality is
gone."

Accurate, and worse than it sounded, because two separate things had gone:

1. **The plan map had no candidate list at all.** Every curated stop existed
   only as a map pin. Tapping one opened `CorridorStopCard`, which showed a
   name, the `why`, the literal word "Status: proposed", and buttons.
2. **Those buttons were nothing.** The card gated "Lock in" on status
   `proposed` and "Unlock" on `locked` — and everything curated in explore
   mode is `candidate`. So the commonest stop on the screen matched neither
   branch and was left with exactly one offer: **Remove**, which deletes.
   "Can only be removed" was not an impression, it was the code.

The fix is the merge that was asked for: the plan map renders
`ExploreCandidateCard` — the same card the explore list uses — in a
collapsible "Stops to consider" list under the map, in route order, with a
pin tap expanding the list and scrolling to the card. `CorridorStopCard` is
deleted; there is one card for a corridor stop now, not two that drifted.

What survives into planning that did not before: the photo, the sight's own
2–4 sentence description, the base town, the interest it serves, how long it
takes, the Maps link, and the three-way interest level as a live control
rather than a value shown once and then frozen.

What the plan map adds, because a plan is what makes them possible:

- **"Add to route"** on a locked stop, opening the panel that reconciles it
  into the day sequence. It was the sentence 'Use "Edit route" to add this
  stop to your itinerary.' — an instruction standing where the one action
  that matters should have been.
- **"On route"** for a stop already reconciled into a day, the same badge the
  explore list uses for a kept stop.
- **"Not interested"** replaces **Remove**. Rejection is remembered
  (`corridorStopStatusSchema`), so the next "Find more stops" does not hand
  the place straight back; deletion is a tombstone thrown away.

"Lock in" now covers `proposed` as well as `candidate` — a rescan find made
while a plan exists is written `proposed`, so that gate had the same hole
from the other direction.

And then: "Clicking a list item does not pan the map to the corresponding
pin." It never had. This screen's `MapPanner` was wired to `selectedPlace` —
the day's activities — which was invisible for as long as a corridor stop
could only be selected by tapping its own pin, because then the camera was
already there. A list gave the selection a second origin the camera knew
nothing about. `panTargetFor` decides between the two now, and each selection
clears the other so one camera never has two claims on it.

Extracted as a pure function rather than left as a ternary in the JSX for one
reason: a pan cannot be asserted without a live Google map, which needs a key
CI does not have — the same constraint that let the layout regression below
ship. If the only testable form of a rule is a function, it should be a
function. The plan map's pins also carry the interest colours now, and the
list header carries the key: they sit beside the same cards as the explore
map, and a level that paints a pin on one screen and not the other is what
makes two screens feel like two apps.

Broken and fixed within the hour: the list starved the map to nothing.
`flex-1` is `flex: 1 1 0%` — a basis of ZERO — so the moment a tall sibling
sat below it in the same flex column, the map got no height at all and only
its absolutely positioned children survived, floating over the list.
Reported as "now the map is gone". The map has a `min-h-[260px]` floor now
and the list scrolls inside itself at `max-h-[50vh]`, which is the split
ExploreMapScreen already used. The new e2e passed straight through the
regression because not one of its assertions looked at the map; it measures
`map-canvas`'s bounding box now.

Also that day: **activity and restaurant blurbs got their length back.** The
detail prompt asked for "a one-sentence blurb" while the curation prompt
beside it asked for 2–4 sentences of what is genuinely there — so the
day-by-day cards were thin by instruction, not by accident. It now asks for
2–3 real sentences (what is there, then who it suits) and names the template
this app writes itself, "A well-rated local hike.", as the shape a blurb must
not have — since a blurb of that shape is indistinguishable from a
verification failure.

**2026-08-18, and a lesson about how a fix gets paid for.** Reported as "the
descriptions for activities seems to have become quite generic". They had
not: those cards were SUBSTITUTES. A proposed activity that fails Places
verification is not shown as a gap — `enrichActivities` drops it and
`backfillActivities` fills the slot with the best-rated thing of its kind
nearby, flagged `substitute` and carrying the template blurb "A well-rated
local hike." So a run of generic descriptions is what a run of failed
verifications looks like from the outside.

The extra failures were the previous day's name-matching fix. Tightening
two-word names to "all of them" is what caught the go-kart track; tightening
THREE-and-longer names to all-but-one went along with it for symmetry, and no
reported failure ever asked for that. It cost real suggestions:

| identifying words | before | the overshoot | now |
|---|---|---|---|
| 1 | 1 | 1 | 1 |
| 2 | 1 | **2** | **2** |
| 3 | 2 | 2 | 2 |
| 4 | 2 | 3 | 2 |
| 5 | 3 | 4 | 3 |

Only the two-word row is still tighter than it was — the row the bug came
through. The category-conflict check, which is what actually distinguishes a
bike park from a go-kart track, was never the expensive half and is untouched.

Two things came out of it that stand on their own:

- **A substitute describes itself in Google's words** when Google has any.
  `places.editorialSummary` is now in the field mask and becomes the blurb,
  with the template only as a fallback. It is Google's line about the very
  place being shown, so it carries none of the risk that inheriting the
  proposal's blurb does (that is how a shopping centre came to be described
  as "Charming lakeside café near the castle") — and it is the difference
  between a card that reads like a suggestion and one that reads like filler.
- **Dropped proposals are logged**, one line per day and per meal, naming
  them. They were invisible: not a gap on the day, not a line in the log, so
  how much of a plan was judgement and how much was fallback could not be
  measured at all. That is why this arrived as a hunch about tone rather than
  a number.

Recorded as a known limitation rather than assumed away: a category
translated into a compound ("Nature Reserve" against "Naturschutzgebiet") is
still not matched, and loosening the count would not fix it — the place name
is one hit out of three. `CATEGORY_GROUPS` handles categories that are their
own word; compound translations are a bigger job, and getting them wrong
reopens the hole.

**A verification defect worth recording**, found while checking the above.
Several "e2e green" claims this week were made by running
`npm run test:e2e 2>&1 | tail -N` and reading the exit status. A pipeline's
exit status is the LAST command's — `tail` always succeeds — so that check
could only ever report success, whatever the suite did. Run the suite
redirected to a file and read `$?`, or check the reporter's own summary line;
never pipe it into `tail` and trust the code. (The suite was in fact fine:
119 passing, plus load-flakiness in `corridor.spec.ts:22` and
`share-view.spec.ts:32`, both of which pass when run alone.)

Two e2e notes that follow from the same investigation. The sandbox's Chromium
build does not match what the pinned Playwright expects, so the suite needs
`PLAYWRIGHT_CHROMIUM_PATH=/opt/pw-browsers/chromium` — the config already has
that hook. And a marker's colour cannot be asserted in e2e at all:
`<AdvancedMarker>` only mounts inside a live Google map, and
`VITE_GOOGLE_MAPS_API_KEY` is a CI secret, so such a test passes or fails by
environment rather than by behaviour. Pin colour is unit-tested
(`MarkerBadge.test.tsx`); e2e asserts the legend, which renders either way.

Still open, deliberately:
- Why the web search tool was unavailable for that run is NOT diagnosed. The
  evidence is model-authored text inside a stored section ("could not be
  freshly verified via web search this session"), not an app log, and this
  environment cannot reach the logs. The instrumentation above is what makes
  the next occurrence answerable rather than another guess.
- The Maps/Places API key still has no HTTP-referrer restriction. Every photo
  URL on a card carries it, on the day-by-day plan and now on the explore
  list. Owner action, outside this repo.
- A failed free-camping rules lookup is planned as "not permitted". Correct
  and conservative, but the night cannot distinguish "illegal here" from "we
  could not check".
- The segmented-generation machinery (`GENERATION_TIME_BUDGET_MS`,
  continuation chaining) is now rarely needed but still correct — see the
  "route eagerly, detail lazily" entry above.

### 2026-08-19 — moving a trip stopped costing the whole plan

Asked, after the entry above: "how to just change dates of the trip then?"
and "so I can change dates during planning?" The honest answer was that you
could edit them, and then the only button on offer was **Rebuild plan** —
every day deleted, every per-day choice with it. Leaving a week later cost
the same as changing the route.

Moving a trip without changing its length changes nothing except every day's
date. Same towns, same order, same activities. So `src/lib/dateShift.ts`
offers exactly that, as a second button on Trip Setup above the rebuild:
**"Move the plan 7 days later"** — one `writeBatch` rewriting each day's
`date`, plan back to `ready`, no Claude call and no Places call.

The condition it is offered under is the whole design:

- **Only when dates are the entire reason the plan is stale.** That needed a
  new field — `planMeta.staleSettings`, written by `updateTripSettings` with
  `arrayUnion` as the invalidating keys that were actually edited, and
  deleted (`FieldValue.delete()`) at every point generation marks a plan
  `ready`. Staleness on its own could not carry this: a trip whose
  drive-hours ceiling also changed has a problem re-dating does not answer,
  and quietly marking it ready again would bury that.
- **A missing reason is not "only the dates".** Plans that went stale before
  the field existed carry nothing, and the shortcut is not offered for them.
  No worse off than before, and nothing is guessed.
- **Never when the trip's LENGTH changed.** Checked against the plan's own
  span (first day to last) rather than trusting the settings: same span plus
  a moved start is a shift; anything else is a real planning problem — where
  the extra night goes, what gets cut — and stays with Rebuild plan.
- **One batch.** A half-shifted plan, days carrying two different offsets,
  would be worse than the state being fixed.

So the answer to "can I change dates during planning?" is now yes for a
move, and still a rebuild for a longer or shorter trip — which is the
distinction that was always true and never surfaced.

A verification note, since the last entry made one: the length-change e2e
test failed on first run and the bug was in the test, not the app. It edited
a date immediately after `page.reload()`, before the seeded `ready` status
had reached the client — and `updateTripSettings` deliberately only marks a
plan stale when it can see it was ready, so nothing happened. It now waits
for `plan-status` to read `ready` first. Worth recording because the failure
looked exactly like a missing invalidation rule.

### 2026-08-22 — five finds, none locatable, and why that was never believable

Reported from a rescan over the Alps near Plansee: "Suggested 5 places, but
none of them could be found on the map, so they were dropped." Objection:
"This seems unlikely, why would it find 5 stops but then no map?" Correct —
on this path it is not merely unlikely, it is close to impossible, and the
code says why.

`verifyPlaceLocation` is called there with `NO_QUALITY_BAR` and
`Number.POSITIVE_INFINITY` as the distance ceiling, deliberately: geography
is `filterFindsToCorridor`'s job afterwards. So neither ratings nor distance
can drop anything on that call. A Places outage cannot produce this message
either — `textSearch` throws on any non-OK status, and an all-failed batch
re-throws rather than reporting places-not-found. By elimination the **name
check was the only gate left**, and "none of them" means it rejected all
five.

**German is where it breaks, and it breaks structurally.** Danish and Swedish
put the category in its own word — "Kronborg Slot" → "Kronborg Castle" — which
`CATEGORY_GROUPS` already bridged. German welds it onto the place name
("Pöllatschlucht", "Marienbrücke") or leads with it ("Aussichtsplattform
Höllkopf"), while the listing that comes back separates and translates it
("Pöllat Gorge", "Mary's Bridge", "Höllkopf Viewing Platform"). A German
compound is ONE token, `requiredNameHits(1)` is 1, and a one-word name can
therefore share no word at all with its own listing and score zero out of
one. Verified before changing anything: of twelve name pairs of that shape,
five were rejected outright.

Three fixes, in the order they matter:

- **The drop is logged now.** It was recorded nowhere: `verifyPlaceLocation`
  returned null and the caller dropped the find in silence, so which five
  names failed, and what Places offered instead, existed nowhere at all.
  This is why the answer above is reasoning from code rather than from the
  incident — the incident left no evidence. It now logs the two sub-causes
  apart, because they read completely differently: nothing came back at all,
  versus results came back and none satisfied the name check. The second
  form prints the rejected names, since the comparison is the whole
  diagnosis.
- **`CATEGORY_GROUPS` gained gorge, bridge, viewpoint and nature reserve** —
  each one taken from a demonstrated rejection. This also closes a
  limitation recorded here as open on 2026-08-18: "Schellbruch Nature
  Reserve" against "Naturschutzgebiet Schellbruch" was asserted unmatchable
  then, and its test now asserts the opposite. Found while doing it:
  `'ställplats'` had sat in that table unmatchable since it was written —
  keywords are compared against de-accented tokens, so an accented keyword is
  dead on arrival. Fixed, and the rule is now stated above the table.
- **A compound matches the bare name it is built on** (`compoundOf`):
  "Tegelbergbahn" against "Tegelberg", for the cases where the welded-on part
  is a funicular or a mill and no table will ever list it. Prefix-anchored
  and six characters minimum — at four, "Berg-" and "Stein-" would make every
  unrelated place in one valley match, which is the go-kart failure in a new
  costume.

**What the category rule costs, and the part that pays for it.** Every gorge
agrees with every other gorge, so a name whose only matchable signal is its
category matches all of them. That cannot be had one-way — it is the same
rule that finds "Pöllat Gorge". What must not happen is the stranger
*winning*, and before this it could: both scored one hit, the tie fell
through to rating, and rating is where the famous wrong answer is strongest.
So `nameMatchScore` halves a match with no shared word at all. Two attempts
at that were wrong before one was right, and both failures were the same
shape — the union denominator handing the discount straight back:

1. Discounting the hit instead of the score: one category hit out of a
   one-word name scored exactly what one real hit out of a two-word name did.
2. Discounting the score, while still charging the result for the translated
   category as an "added" word. "Wolfsklamm Gorge" says gorge twice, once per
   language, and being charged for the English half put it *below* a
   different gorge whose single word was its whole name.

Added words are still evidence against a result — that is what keeps
"Sletten Bageri" below "Sletten" — but a word restating a category the
request already stated says nothing new and is no longer counted.

Recorded as still open, and asserted as a test rather than assumed away: once
a listing is fully translated, "Marienbrücke" and "Mary's Bridge" share no
word, so the match rests entirely on both being bridges — and so would a
match against any other bridge. No string comparison separates those; it
needs a dictionary. The corridor distance filter is what protects the result,
and it reports an out-of-area drop rather than a silent one.

**Not changed, deliberately.** The `textSearch` request sends no
`languageCode`, so which language a listing comes back in is not something
this code decides — and the card in the report reads "Neuschwanstein Castle",
not "Schloss Neuschwanstein", which is consistent with English being
returned but does not establish it, since Claude may simply have proposed the
English name. Setting `languageCode` per country would as easily flip the
failures as remove them: Claude proposes in either language, and forcing
German listings would break the English proposals the same way. The logging
above is what will settle it — the rejected names it prints say which
language Places actually answered in.

### 2026-08-22 — the search was told it was looking at a district

The 7 km scan over Plansee returned four finds, all outside the circle. The
first reading of that was that 7 km was too small, and a 25 km floor shipped.
That was wrong, and the correction was immediate: "It was right to limit at
7 km. It was wrong to find nothing within the 7 km. There are for sure things
to do! How did it conclude there was nothing within the circle?"

It never concluded that. It was never asked.

**The model is given no coordinates.** That is deliberate — hard rule 2 of
the prompt, so it cannot invent distances — which makes `areaDescription`,
one reverse-geocoded string, the ENTIRE statement of where the circle is. Its
precision therefore has to match the circle's size, and nothing made it.

`reverseGeocode.ts` preferred `locality`, then `postal_town`, then
`administrative_area_level_2`. A point in the middle of a lake is in no
locality at all, so it fell through to level 2 — in Austria the Bezirk. The
search was told: *area "Reutte, Austria", radius 7 km*. Reutte District is
about 1,200 km². It answered with the best of that district — Ehrenberg, the
highline, Reutte itself — four real places, every one a correct answer to the
question it was actually asked, and every one 10 km or more from a circle
they were then measured against and dropped for missing.

Nothing in the reply was wrong. The question was.

- **A named feature now outranks any administrative area.** `NAME_PRECEDENCE`
  runs natural feature → park → attraction → establishment → settlement →
  road → administrative area, largest last, so the centre resolves to
  "Plansee" rather than to the district it floats in. Plus codes are excluded
  outright: a plus code is a coordinate in disguise and names nothing. The
  original intent — the town, not the street address of whatever pixel the
  centre landed on, and not "Austria" either — survives as this ordering
  instead of as a three-rung ladder that skipped past the lake.
- **The prompt now says the radius binds, not the area name** (rule 1a), and
  that the region's best-known places are the WRONG answer to a small circle
  even though they are the best-known places in it.
- **And what a small circle IS answered by** (rule 1b), which is the half
  that makes it produce something rather than merely produce less: the lake
  and where you swim in it, the marked trail from the car park, the
  viewpoint, the gorge walk, the hut, the cable car station, the one
  restaurant in the hamlet. An empty list is for empty ground, not for ground
  that merely has nothing famous on it.

**The 25 km floor is reverted.** Aiming the circle is the traveler's, and a
floor overrides the aim — it answered "the circle is too small" to a report
that was never about the circle. Recorded here rather than quietly dropped,
because the wrong fix shipped to production before the right one: the
symptom (finds outside a small circle) admits both readings, and the one that
required no explanation of how the search actually works was the one taken
first.

Kept from that attempt, because it is right on its own terms: **the
out-of-area advice branches on whether the cap bit.** "Zoom in" is correct at
`MAX_RESCAN_RADIUS_KM`, where the circle has stopped tracking the view, and
backwards below it.

**A verification failure of a kind not seen here before.** The e2e test for
that message seeded `rescanLastRadiusKm: 50` and asserted "zoom in", with a
comment reasoning "the search radius is already capped". 50 WAS the cap when
it was written. The cap moved to 150 on 2026-08-17, the premise silently
became false, and the test kept passing — because the advice it asserted was
given unconditionally, so it passed whether the premise held or not. A test
can stop testing what it claims to test without ever going red. It now seeds
`MAX_RESCAN_RADIUS_KM` by name, with a sibling at 25 km asserting the
opposite advice; naming the cap from a spec is also why the radius constants
moved to `src/lib/rescanRadius.ts`, since importing them used to drag a
Firebase client import into the Node-side test process.

### 2026-08-22 — asking Places what is in the circle, instead of asking Claude to remember

Third report of the same thing, now at 6 km: "Found 5 places, but they were
outside the 6 km searched." And in the same screenshot, drawn by Google
inside that circle: Aussichtsplattform Höllkopf, the Stuibenfälle, the
Soldatenkopf trail, Campingplatz Fischer am See, Sunnawirt.

The two previous fixes were aimed at the ANSWER — first the circle was too
small (wrong, and reverted), then the anchor named a district instead of a
lake (real, and worth fixing, but not sufficient). What neither touched is
that the question itself cannot be answered by the thing being asked.

**The plain rescan asks Claude, from memory, to name places near a
reverse-geocoded area name.** No coordinates, deliberately, so it cannot
invent distances. No tools, deliberately, since web search was removed on
2026-08-16 for suppressing correct answers. So at 150 km it is a fair
question and the answer is good; at 6 km it is impossible, and the model does
the only thing it can — name the best-known places of the region — which the
distance filter then discards in full. Every "found N, all too far" reply was
that, and no amount of prompt tuning fixes a question with no answer.

Google Places knows exactly what is in that circle. It is what drew the map.

`searchPlacesInArea` sweeps the circle with `locationRestriction` — a HARD
bound, unlike the `locationBias` used elsewhere, which only nudges ranking
and still returns whatever it likes. One request per place type rather than
one for all of them, because Places ranks a mixed request by prominence: in a
valley with one famous sight, a single call returns that sight twenty times
and never mentions the trailhead. The types are deliberately wider than
`ACTIVITY_PLACE_TYPE`, which serves a day's itinerary — this answers "we are
parked HERE, what is there", so campsites, RV parks and guest houses belong
in it as much as museums do.

The result goes into the prompt as `placesInArea`, with rule 1c: it is ground
truth about what is inside the circle, build the answer from it, choose the
ones genuinely worth stopping for, and its absence is never evidence that an
area is empty. The judgement stays the model's — a raw Places dump ranked by
rating is exactly what this call exists not to be — but it now judges a real
list instead of recalling a region.

Structurally, the failure that was reported three times is now impossible for
anything sourced this way: a place returned under `locationRestriction`
cannot be outside the circle, so the corridor filter has nothing to drop.

Scoped deliberately:
- **Only for a plain point-and-radius sweep.** A backbone search spans a
  corridor rather than a circle, and a typed query already has its own
  Places-first path (querySearch.ts, 2026-08-02 — this is the same lesson
  arriving at the path the app drives itself rather than the traveler).
- **A failed sweep is not a failed search.** The key is omitted and the
  prompt behaves exactly as it did, rather than sending an empty list that
  reads as "there is nothing here".

Also kept from the previous commit and still correct: named features outrank
administrative areas when naming the centre, and the out-of-area advice
branches on whether the cap bit.

**Suite note, stated rather than smoothed over.** The full e2e run finished
124 passed / 1 failed — `dayview.spec.ts:140` ("a submitted rest day is
acknowledged"), which passes on its own (14/14) and touches nothing in this
change. That is the same load-flakiness already recorded here for
`corridor.spec.ts:22` and `share-view.spec.ts:32`, now with a third member.
Recorded as a known flake rather than reported as a green suite.

### 2026-08-22 — the sweep is a floor, not a ceiling

Challenged, correctly, on the previous entry: "But there must have been some
merit to the old solution!? And now it's disabled for all rescan calls? I
don't like that."

The model was never disabled — it still runs on every rescan and still writes
every "why". But the objection found a real defect, and this codebase has the
scar already: **web_search was removed on 2026-08-16 for exactly this**, and
the note above says so in as many words — "that made the search a GATE on
what could be proposed rather than a source... anything they missed was
forbidden, including everything the model already knew". Handing the model a
Places list has precisely that shape, and the first version of it wrote
"ground truth about what is there and you should build your answer from it",
which is how a source becomes a gate.

Three things were wrong, all in that direction:

- **The sweep claimed a circle it had not covered.** Places caps a nearby
  search at 50 km. On a 150 km circle the sweep surveys the middle third and
  knows nothing about the rest — while the prompt called it "every notable
  place Google Maps knows of INSIDE the circle". A partial list offered as a
  complete one is worse than no list, because everything absent from it reads
  as absent from the ground. The sweep is now skipped entirely above
  `SWEEP_COVERS_UP_TO_KM`, which is also exactly where the model unaided has
  always been good: "what is worth stopping for within 150 km of here" is a
  question it answers well and has since this feature existed. The sweep is
  for the small circle, where that question is unanswerable.
- **`natural_feature` was missing from the types.** In an Alpine valley that
  omits most of what anyone stops for — the Plansee itself would not have
  been on the list handed to a search about the Plansee.
  `historical_landmark` added alongside it.
- **The rule now says the list is a FLOOR, NOT A CEILING**, and says why:
  Google has no listing for most trailheads, swimming spots, free-camping
  pull-offs, viewpoints and local favourites, and ranks what it does have by
  review count rather than by whether anyone should go. So: use it as
  evidence, and go on adding the places you know are in that circle whether
  or not they appear on it. "A good answer that Google has never heard of is
  exactly what this search is for."

What each half is actually for, which is the thing the first version blurred:
Places can prove a place is inside a circle and cannot judge whether it is
worth stopping at; the model can judge that and cannot measure. Neither
replaces the other, and the failure mode of pretending otherwise runs in both
directions — three empty scans when the model was asked to measure, and a
suppressed local favourite when Places is asked to judge.

### 2026-08-22 — side by side on a landscape tablet

Requested: "there was previously a side by side map and list in landscape
mode on iPad. It's gone since the map size fix. Bring it back!"

Checked before building: **it was never on these screens.** All twelve
versions of OverviewMapScreen in history stack, and none contains a single
responsive class. The split being remembered is DayViewScreen's — `lg:flex-row`
with map and detail each `lg:w-1/2` — which has been there since the first
commit and which the 2026-08-19 map-size fix never touched. Said plainly and
then built anyway, because the request is right on its own terms: an iPad in
landscape has room for both at full height, and stacking spends half of it on
a list that then scrolls inside itself.

Both map screens now split, matching Day View. `lg:landscape:` rather than
`lg:` alone, and the orientation half is the part that matters: the 12.9"
iPad is **1024px wide in portrait too** — through the breakpoint, and exactly
the shape that should stay stacked. Width only rules out phones held
sideways; orientation is the actual question. The list becomes a fixed 384px
sidebar rather than a share of the width, because these cards carry a photo,
a paragraph and four buttons and should read the same at every size.

**Two test failures worth recording, both mine, and neither a layout bug.**

First, the portrait assertion failed claiming the map was 1248px tall when it
is 1021. It measured the map BEFORE the corridorStops snapshot arrived — so
the map still had the screen to itself — and then measured a list that only
existed afterwards. A geometric assertion is only as good as the moment it is
taken at; both elements are awaited before either is measured now.

Second, and more interesting: `explore.spec.ts` "marking a stop must-see"
started failing on `card.click()`. Playwright's default viewport is
1280×720 — wider than `lg` AND landscape — so the e2e browser now gets the
sidebar, exactly as a desktop should. In a 384px column a card is tall
enough that its geometric CENTRE, which is where `click()` aims, lands on one
of its own buttons. The click hit a control instead of the card. Fixed by
clicking a fixed offset inside the card's padding, since every other element
in the card is conditional on the stop's data and the padding is not.

That second one is a genuine finding rather than a test detail: the default
e2e viewport now exercises the split on every run, which is the cheapest
possible coverage of it. New tests assert the geometry at 1180×820
(side by side) and 1024×1366 (still stacked) — by bounding box rather than by
class name, because what can break here is a layout that computes wrong, not
a class that goes missing.

### 2026-08-22 — asking Google what KIND of place it is

Reported with a screenshot: a card headed "Noleggio E-bike ERBEZZO c/o
Ristorante La Stua" carrying the description "A proper downhill/enduro bike
park on the Lessinia plateau with lift-served gravity trails". The question
asked was the right one: "Two rental bike places rather than what the text
seems to reference. Is there another solution to this issue? Or can I trust
that there are mtb trails there?"

**No, and the reason is worth stating plainly, because it governs every card
on that screen.** The description is Claude's, written about the place it
PROPOSED. The name, the pin and the photo are Google's, from whatever Places
matched. When those two disagree nothing reconciles them — the blurb stays
attached to the wrong place. So the text may well describe a real bike park
on the Lessinia plateau while the pin sits on a rental counter at a
restaurant, and the pin is the part that is checked.

This is the Bruzaholm go-kart bug's family, and the third time this shape has
been reported. String comparison cannot fix it: "Bike Park Erbezzo" and
"Noleggio E-bike ERBEZZO" share the village AND share the word "bike", which
`CATEGORY_GROUPS` treats as agreement — correctly, since that is the same
rule matching "Kronborg Slot" to "Kronborg Castle". The difference is not in
the words at all. One is a place you ride, the other a counter you hire from.

**Google has always known which, and this file had never asked.**
`places.primaryType` is Google's own classification of the listing. It costs
nothing extra in the field mask, it has been available on every response this
code has ever made, and it was not requested. So a listing Google files as a
bike shop, a rental desk, a dealership or a mall is now rejected when the
request did not itself say shop or rental — `servesTheWrongPurpose`.

Two deliberate limits on it:

- **A deny-list of service types, not an allow-list of acceptable ones.**
  Places has hundreds of types; an allow-list would silently reject
  everything nobody thought of. Over-tightening this gate has a known cost
  and it is not hypothetical — a rejected proposal is not shown as a gap, it
  is quietly replaced with a template blurb, which is exactly what "the
  descriptions have become quite generic" was on 2026-08-18. Nothing here
  rejects a place for being obscure, only for being a different KIND of
  business. A weavery you can visit is still a sight.
- **Retail words in the REQUEST disable it.** Someone who types "bike hire"
  wants precisely that listing, and the check must not fire for them —
  matched across the languages this corridor actually crosses
  (noleggio/verleih/uthyrning/hire/…), not just English.
- **An unclassified listing is not evidence.** No `primaryType` means the
  gate stays shut, the same conservative reading `origin` takes for stops
  written before that field existed.

Still open, and NOT fixed by this: when a proposal does resolve to a
plausible-but-different place, the traveler is shown Claude's description of
what it meant rather than of what was found, with nothing on the card saying
so. The honest options are to say it on the card ("suggested X, nearest
match Y") or to drop Claude's blurb whenever Places' name diverges far
enough. Neither is built; the type check removes the commonest cause rather
than the class.

### 2026-08-22 — "already on your list", about a list nobody sent

Reported with a screenshot of two cards — "Already on your list — this is one
of the best hiking and panoramic points…" and "(which the Greenway Fiume Sile
cycle path already on your list runs through)" — and the question: "I can't
find any other stops. Why?"

**Because the search has never been told what is on the list.** The rescan
prompt carries the trip's interests, its freeform notes, the route waypoints,
and (for a small circle) the Places sweep. It has never carried the
corridor's own stops. So that phrase could only ever have meant one of two
things: a line in the NOTES, which is not a stop and does not appear on the
map, or nothing at all. Either way the traveler reads it as "this is already
a stop" and goes looking for something that is not there.

Which of the two it was on this trip is **not determinable from here** — it
depends on what that trip's notes say, and this environment cannot read them.
Both are fixed the same way.

The same gap had a second cost with no words attached: with no idea what the
trip already held, nothing stopped a rescan re-proposing it, **and nothing on
the write path deduplicated either** — every find was `add`ed unconditionally.
A traveler rescanning ground they had already covered got a second card for a
stop they had already judged, including ones they had turned down, which is
the worse half.

**Then the traveler answered the open question: "They were not in notes."**
That rules out the only grounded source. `waypointNames` — the other thing
the prompt carries that names places — is the start point, the LOCKED route
stops and the end point, all of which are on the map and findable. There was
nothing left for the model to have been reading. It asserted it.

That changed the fix. The first version of rule 1d allowed the phrase when it
was TRUE — only about a name on the list — which is a rule about the model's
judgement, evaluated by the model. Forbidding the claim outright is a rule
about its output. And it costs nothing: **whether a stop is saved is
something the app knows for certain and already marks on every card** ("On
route", "Locked in"), so this was never a fact the model was the right source
for. The division is the same one that keeps being the answer here — Places
for what exists, the app for the trip's own state, the model for judgement.

- `existingStopNames` reaches the prompt as `alreadyOnTheList`, capped at 60,
  and is now for ONE purpose: not proposing the same place twice. Rule 1d
  forbids writing "already on your list", "already on your radar", "already
  planned" or anything of the kind, and forbids referring to the traveler's
  other stops, route or itinerary in "why" at all.
- Omitted rather than sent empty on a trip with no stops yet: an empty array
  reads as a statement that the list is empty, which is a different claim
  from having nothing to say.
- The write path drops a find whose name matches a stop the trip already
  has, folding case, punctuation and diacritics. Deliberately NOT the
  `nameLooksRight` machinery: this asks "is this literally the stop we
  already have", not "is this plausibly the same place", and a false positive
  here silently discards a genuine new find.
- `stopsWritten` counts what was actually written, so the banner cannot say
  "Found 2 new stops" about one.

**Suite note.** The full e2e run finished 125 passed / 2 failed —
`countries.spec.ts:163` and `dayview.spec.ts:140` — both of which pass when
their files are run together (19/19) and neither of which touches anything in
this change. Same load-flakiness already recorded for `corridor.spec.ts:22`
and `share-view.spec.ts:32`; `countries.spec.ts:163` is a new member of that
set. Recorded rather than reported as green.

### 2026-08-23 — the board is the Map tab now (board rework, phase 1 of 8)

Reported: *"the whole locking the trip doesn't work for us… As soon as it
goes to detailed plan, I feel like it's too restricting and I actually lose
the overview."* And, on what to do about days: *"keep the generate trip thing
but make it looser and easier to change / less strict about pace/exact days.
I don't like that it goes 'stale' and needs full generation. It should just
grow organically."*

**The overview was lost to one line.** `OverviewMapScreen.tsx:299` read
`if (planStatus === 'idle') return <ExploreMapScreen …>`. That is the entire
mode switch: the board existed only while no plan did, and the moment
`planMeta.status` stopped being `idle` the Map tab rendered a different
screen. Everything the board offers — lock in, set a priority, rescan the
area, add a stop — went with the swap, leaving a screen that could show a
finished plan and ask for it to be regenerated. Nothing was being deleted and
no layout decision was involved.

So the branch is gone. `OverviewMapScreen` is now a four-line delegator that
reads the trip out of context and renders the board; what the day-by-day view
contributed that the board did not is rendered ON the board by a new
`PlanStrip` — totals, `header-day-count`, pacing advice, "Request changes",
"Edit route", and a horizontally scrolling **day strip** that opens Day View.
A plan is something the trip HAS now, rather than somewhere the traveler
GOES.

Deliberate decisions inside that:

- **`PlanStrip` is its own component**, not more lines in `ExploreMapScreen`.
  It owns two pieces of state nothing else on the board needs (the
  change-request form, the pacing dismissal). The reorder panel's open flag
  is the exception and is held by the board, because a locked unlinked stop's
  own "Add to route" button opens it — the cards are the board's, the panel's
  stop lists are PlanStrip's, so the flag has to sit above both.
- **The status and offline banners moved to the board, not into PlanStrip.**
  They are facts about the trip and the connection, not about days: a
  generation in flight is precisely when there are no days to report on.
- **The day strip scrolls horizontally.** Sixty wrapped chips would push the
  map off the screen — the same failure the stops list was given a height cap
  for on 2026-08-19.
- **The day-specific map layers were not carried over** — per-day overnight
  pins, the selected day's activity/restaurant markers, and the polyline
  threaded through each day's best activity. They are in git history at
  3529d59. The board draws the same route from the locked stops those days
  are built from, and the per-day places remain on Day View. Recorded as a
  real loss rather than glossed: seeing every night on the overview map is
  gone until the phase-4 skeleton commit makes days derive from the board.

**What the e2e caught, which is the reason to write it down.** The first run
after deleting the branch was 120 passed / 7 failed, and three of those were
not test bookkeeping — the **generating, error and offline banners** had lived
only on the deleted screen, so a generation in flight would have reported
nothing at all. A fourth was worse: `explore-candidate-add-to-route` never
rendered, because the board never passed `onAddToRoute` — silently undoing
the 2026-08-19 "give a locked, unlinked stop a real way into the route" work.
None of that was visible from the diff; all of it came from the suite.

New tests assert the phase's actual claim rather than its plumbing: a planned
trip still offers "Find more stops", "Rescan this area" and its curated list,
*and* carries the plan's header and day strip, with a day chip opening
`/map/day/:id`; a trip with no plan shows the board and no plan chrome at all.
Asserted through the actions rather than a container testid, because "the
board is present" means "I can still curate".

Verification: lint 0, build 0, frontend 252, functions 641, e2e **129**.

Phases 2–8 (pace as advice, stop going stale; stay durations and an honest
day budget; the cheap skeleton commit; manual route order; per-stop overnight;
position marker and mark-done; live mode) are planned and tracked but not
started.

### 2026-08-23 — pace is advice, and almost nothing goes stale (board rework, phase 2 of 8)

*"Keep the generate trip thing but make it looser and easier to change /
less strict about pace/exact days. I don't like that it goes 'stale' and
needs full generation."* Two separate mechanisms, and reading each changed
what the fix should be.

**Pace: split the validator rather than move its throw.**

The approved plan said "keep `validatePacing`'s throw in `generatePlan`, drop
it in reconciliation". Reading the function made that the wrong cut, because
it enforced **two different kinds of thing under one throw**:

| Rule | Kind |
|---|---|
| day drives > 1.5 × `maxDriveHoursPerDay` | a **preference the traveler set** |
| rest day not at the previous day's overnight | a **malformed plan** |

A rest day that teleports to a fresh transit town is broken wherever it was
built, so it must keep throwing everywhere. A long day is the traveler's to
accept — and it was at its worst on the incremental path, where reordering
one stop that made one day long **discarded the entire edit** and returned an
error naming a limit they set themselves.

So `validatePacing(days)` keeps only the rest-day invariant and still throws
in all three callers; the drive-length check moved into `pacingWarnings` as
`driveLengthWarnings`, one warning per offending day, phrased as *"drives
7.2h — more than the 4h/day you asked for"*. No UI work: `PlanStrip` already
renders `pacing-warning-banner` and both write sites already populate
`planMeta.pacingWarnings`. The signature change made the compiler find all
eight call sites, which is why this was safe to do at all.

**Staleness: check what it does before deciding how much can leave it.**

It does far less than the name suggests. `stale` has **exactly two effects** —
the Trip-setup button reads "Rebuild plan", and `dateShift.ts:59` gates its
shortcut on it. Nothing blocks. A stale plan renders, opens, shares and
drives like a ready one. It was never a broken plan; it was an offer to pay
for a new one.

`NON_INVALIDATING_SETTINGS` grew from `{detailWindowDays, interests}` to also
cover `maxDriveHoursPerDay`, `restDayFrequency`, `preferredCountries`,
`travelers`, `vehicle` and `offGridTolerance`. The test each had to pass was
not "could this matter?" but **"does this make the days already written
wrong?"** — and none of them do. They change what to look for, what is
suitable, or what to measure against, all of which apply from here on.

Still invalidating, deliberately: `startDate`/`endDate` and
`startPoint`/`endPoint`, which change the ground the days were built on.
Dates already have the cheap answer (the "Move the plan N days later"
shortcut); endpoints get one in phase 4.

**The trap this was checked against, and it would have been silent.**
`staleSettings` is written with `arrayUnion`, so it **accumulates**, and
`detectDateShift` only offers the shift when every entry is a date key.
Widening that field to record every edit — tempting, for a "what changed
since" note on the board — would have meant that changing the drive-hours
limit and *later* changing the dates left
`['maxDriveHoursPerDay','startDate']`, no longer dates-only, and yesterday's
shift button would have quietly stopped appearing on precisely the trips that
had been fiddled with most. So the field keeps its exact meaning, no
informational field was added, and a test now drives that two-edit sequence.

**Two tests flipped, both asserting the old behaviour by name**, which is the
honest signal that the behaviour really changed:
`corridorReconciliation.test.ts` "leaves the trip untouched when the new order
fails pacing validation" → now commits the reorder and warns; and
`settings.spec.ts` "editing settings on a trip with a ready plan marks it
stale" → re-pointed at the end date and retitled "editing a setting the days
were built on", since it moved the drive-hours slider to assert a rule that
no longer applies to it.

Verification: lint 0, build 0, frontend 260, functions 642, e2e **130**.

### 2026-08-23 — the board became a planning tool (board rework, phase 3 of 8)

*"I want to be able to state how long we intend to stay at that
activity/stop. This will yield a total duration that we can then simply
curate ourselves by locking/unlocking stops."* And: *"It should be possible
to determine the distance and time between locked in stops."*

**The total is in DAYS, and that is the whole design.** `sum(stay) +
sum(drive)` is not a trip length: you cannot do a full-day sight AND a
six-hour drive on the same day, which is precisely why `maxDriveHoursPerDay`
exists as a setting. "84 h 20 min" cannot be curated against — a traveler
cannot tell whether it fits in a fortnight. So `src/lib/tripBudget.ts`
**packs** rather than sums, against two ceilings, whichever binds:

- the traveler's own drive-hours limit, which usually decides a long trip;
- daylight, since drives and sights compete for the same hours — a day of two
  short drives and a full-day castle is a full day even though the driving
  alone would have fitted.

Basecamp nights are added rather than packed: three nights at a lake is three
days whatever else is happening. The header reads `9 stops · ~11 days · 3
spare`, and an overrun is stated as *"3 days over"* rather than as a negative,
because the first is actionable and the second is arithmetic.

Deliberately greedy and simple rather than the real pacing algorithm: this
runs live while stops are locked and unlocked, so it must be instant, pure
and obvious enough to trust. Same reasoning as `planDrift`'s straight lines —
it decides what to TELL someone, not what to do.

**Two shapes of duration, not one number.** `corridorStop.stayDuration` is
`{kind:'hours'}` or `{kind:'nights'}`, because RV travel mixes a one-hour
viewpoint with a three-night basecamp and a total that cannot tell them apart
is useless: nights consume days without consuming driving budget, hours
compete with the drive for the same day. Entering three nights as 72 hours
both reads wrong and packs wrong. **Absent means derive it from `timeNeeded`**
(2h/4h/8h) via `stayCostOf`, so every stop curated before this existed already
has a sensible answer and nothing needed backfilling.

**Per-leg distances were already being fetched and thrown away.**
`DirectionsRoute` iterated `routes[0].legs` only to sum them; `onLegs` now
hands them out. Each is attached to the stop it arrives AT rather than
rendered between cards, because the list is sorted independently of the
driving order — *"what it costs to get here"* stays true wherever the card
sits. Skipped entirely unless `legs.length === stops.length + 1`, since a
chunk-mismatched result would label each stop with its neighbour's drive,
which is worse than saying nothing.

The correspondence that makes it work is worth recording: the backbone is
`[start, ...stops, end]` and Google returns one leg per gap **in the order
actually driven** — which is exactly what `routeStops` is, since that is the
guess reordered by the very `waypoint_order` those legs came back with. So
`leg[i]` is the drive arriving at `routeStops[i]`.

**A build trap, for next time.** `tripBudget`'s first test run failed with
`stayCostOf is not a function` despite a clean `tsc`. The frontend resolves
`@rv/shared` to `shared/dist`, not `shared/src`, so a new shared export is
invisible to vitest until `npm run build -w shared` runs. `npm run build`
does it as its first step, which is why the full gate never sees this and a
single-file test run does.

Verification: lint 0, build 0, frontend **275**, functions 642, e2e **132**.

### 2026-08-23 — days that write themselves, for free (board rework, phase 4 of 8)

Sharing and the diary both read the `days` collection, so both need days to
**exist** — not to be detailed. Until now the only way to get them was a full
generation, which is what made "I'd still like to keep the option of sharing
the trip, diary etc. But that requires me to generate full plan?" a fair
complaint.

Four things checked before writing anything, and all four made this smaller
than it looked:

1. **The client may write days.** `firestore.rules` grants members read and
   write on `days/{dayId}`. No callable, no cold start, nothing to wait for.
2. **The board already holds everything a skeleton needs** — locked stops
   with coordinates and country, the trip's dates, and `routeLegs` carrying
   REAL Google driving times from the Directions call the map is already
   making. That last point is why the legs written here carry no `estimated`
   flag: they are measured, not haversine guesses.
3. **`DayDetailGate` already existed and already does the rest.** Open a day
   whose `detailStatus` is `pending` and it asks for that day and the two
   after it. So a skeleton day is not a dead end — it fills itself in when
   someone looks at it, and costs nothing until then.
4. **A day needs very little**: index, date, type, overnight, summary.

**The one real design problem was which stop lands on which date**, and the
answer shaped the code: the day COUNT must come from the same function that
does the assignment, or the header says "~11 days" above an itinerary of
nine. So `tripBudget`'s packing became a shared `packStopsIntoDays`, and
`tripBudget` now reports `days.length` rather than computing its own number —
one function, two consumers, no way to disagree. A test asserts exactly that
equality.

Packing inserts **drive-only days** where a leg exceeds the daily limit (two
stops 1,500 km apart is four days, not two) and gives a basecamp **its own
days**. "One day per stop" was the tempting simplification and is wrong for
both.

**An off-by-one in my own phase-3 test, found by making the semantics
explicit.** It asserted that `nights: 3` plus a five-hour drive needed FOUR
days — "one day of driving, plus three parked". Nobody had pinned down what a
night meant. Three nights means three nights slept there, so three days, with
the drive that got you there happening on the first. Otherwise every basecamp
would quietly cost the trip a day it never spends. The test now asserts three
and says why it changed.

Guards, all in a pure `planSkeleton` so the effect that calls it has no
judgement of its own:

- **Never clobber detail.** A day with `detailStatus: 'ready'` or
  `'generating'` means someone paid for it; that trip belongs to
  `runReconcileCorridor`, which moves days without discarding what is on them.
- **Never race a generation** (`pending`/`generating` stands aside).
- **A stop with no country is skipped**, since `overnightStopSchema` requires
  a two-letter code and a malformed day would surface far from here.
- **Idempotent**: compared on the fields the skeleton actually decides —
  date, type, overnight name — so a day that later gains an overnight choice
  is not rewritten over a difference this never made.

**And `startPoint`/`endPoint` left the invalidating set.** They were the last
settings with no incremental answer: moving the start point changed the route
the days were threaded along, and only a regeneration could re-thread it.
Not any more. Only the trip's dates still mark a plan stale, and they have
their own cheap answer in the date-shift shortcut.

Verification: lint 0, build 0, frontend **285**, functions 642, e2e **134**.

### 2026-08-23 — the last four phases (board rework, 5–8 of 8)

Shipped together at the traveler's request ("Continue all the way if there
are no questions!!"). Each is small on its own; what they have in common is
that almost every part already existed and was keyed to the wrong thing.

**5 — Route order: Google by default, yours on request.** *"Google should
still optimize the route by default, but there should be some manual override
possible, that can then also be reset."* `RouteOrder` gains `manual`, and it
has to be RECORDED rather than inferred: a hand-made order and an optimised
one are both just lists of positions, so without the flag the next Directions
reply silently overwrites the traveler's arrangement — the override would
appear to work until the map next refreshed. `mayOptimize()` turns Google off
while it holds, ↑/↓ on each kept card writes it, and resetting is simply
dropping it. Also fixed here: `DirectionsRoute` optimises only when the whole
route fits one 25-point request, and past that **silently stopped**, which
the board now says out loud.

**6 — Somewhere to sleep, per stop.** *"Every activity should get a suggested
camping/stellplatz/free camping at the push of a button."* Almost nothing had
to change: `fetchOvernightCandidates` already worked from a coordinate and a
country, and reading them off a DAY was the only part that did not. That body
became `overnightCandidatesNear(near, country, tripId)`, the day path became
one caller, and `getStopOvernightCandidates` is another. Results are held on
the screen rather than written to the stop — they are a lookup, not a
decision, and caching them would go stale silently as sites open and close.
A stop with no country is refused with a reason rather than searched around
nowhere.

**7 — Where we are, and what we have done.** The GPS fix was already being
taken every thirty minutes to measure drift, and never drawn;
`useCurrentPosition` watches instead of samples (a marker half an hour behind
the van is worse than none) and treats only a refusal as denial — a timeout
in a tunnel would otherwise hide the marker for the rest of the session.
`corridorStop.doneAt` is additive, absent means not done, and a done stop
**leaves the route**: the budget becomes what is LEFT, and one of Google's 25
waypoints is handed back as the trip is travelled. The card stays, muted,
because a trip that looks emptier the more of it you have done is the wrong
feedback. `markStopDone` writes the stamp and a diary entry, with the moment
editable and defaulting to now — *"possible to change if we are lazy with
marking done"* — and `createdAt` kept as the immutable record of when it was
typed. Undo deletes the field rather than writing a falsy one, so "absent
means not done" stays the only rule.

**8 — Live: what's around us now.** A separate `searchNearby` callable rather
than a flag on the rescan, because the two differ in the only thing that
matters about a search endpoint — whether it mutates the trip — and a boolean
deciding that is exactly the parameter someone forgets to pass. It reuses
`findStopsForQuery` (Places-first), and the trip's notes and interests reach
it server-side, so "cozy over mainstream" means the same thing from a lay-by
as it does in planning. **Results are ephemeral**: someone looking for lunch
three times a day would otherwise fill their corridor with pins they never
chose. "Add to trip" saves one as an ordinary candidate.

**Two things the tests caught, both mine.**

The first was an assertion I wrote claiming the position marker "renders
without a live Google map". It does not — it is an `<AdvancedMarker>` child,
so it hits exactly the constraint already recorded here for every other pin,
and the test failed with 0 elements. Coverage moved to a unit test of
`useCurrentPosition` against a stubbed geolocation API, which is the same
split MarkerBadge already uses: pin colours unit, legend e2e.

The second was a real defect in that hook, surfaced by writing the test: its
cleanup re-read `navigator.geolocation` instead of using the object it
created the watch on. A global that gets swapped underneath a mounted
component — a test stub, a polyfill — then either throws or silently leaks
the watch. Fixed by holding the reference.

Also worth recording: widening `logEntrySchema.refType` to include `'stop'`
made the compiler stop in `viewSharedTrip`, because that payload lists every
field it sends by hand rather than spreading. That is the design working —
the one payload crossing the trust boundary to a non-member cannot gain a
field by accident.

Verification: lint 0, build 0, frontend **299**, functions **644**, e2e
**136**.

All eight phases of the board rework are shipped.

### 2026-08-24 — dark mode, and the way into the diary

Two reports from the same iPad screenshot: *"Dark mode is not great here. How
do I add to dairy?"*

**The dark-mode cause was not any component's colours.** The document never
declared `color-scheme`, so the browser kept its LIGHT defaults regardless of
`prefers-color-scheme`. The inherited `color` stayed black — which every
element that sets no text colour of its own then inherits, and on a
`dark:bg-neutral-900` card that is black on near-black. The stay / order /
where-to-sleep / done controls shipped the day before were exactly that:
`border border-neutral-300 … dark:border-neutral-700` and no text colour at
all, which is a light-mode-only rule wearing a `dark:` variant. Native
`<select>` popups, the caret, scrollbars and the overscroll gutter were light
for the same reason.

Fixed at the root — `color-scheme: light dark` on `html`, plus an explicit
`text-neutral-900 dark:text-neutral-100` on `html, body` so the inherited
colour is stated rather than left to a UA default — and then at the leaves,
by giving those hand-rolled controls the design system tokens they should
have had: a new `.btn-outline` (outlined pill for a secondary action that
sits ON a card, where `.btn-secondary`'s fill competes with the card itself)
and `.select-pill`. Error text app-wide gained the `dark:text-red-400` half
it was missing in twelve places.

**A second bug fell out of `.select-pill`:** the stay control was `text-xs`.
iOS Safari zooms the page in on focusing any form control under 16px and
never zooms back out — a hazard this codebase already knew about and had
documented on `.field-sm`, and then reintroduced. It is `text-base` now, and
taller than the chips beside it, which is the right trade on the iPad this is
mostly used from.

**The diary question was a real gap, not a misunderstanding.** Entries came
from two places — Done on a place inside a day, and "We've done this" on a
kept stop — and the second committed silently on one tap. The editable moment
was in the original request (*"defaulting to 'now' but possible to change if
we are lazy with marking done"*), reached `markStopDone` as a parameter, and
then had **no UI**. It does now, in the same two-step shape Day View already
used: the button opens a form with the moment pre-filled and a note field,
and nothing is written until it is confirmed. The Diary's empty state names
both paths rather than saying "mark a card Done".

Three things worth recording from building it:

- **`doneAt.slice(0, 10)` was the wrong diary key.** The diary groups by
  `date`, and that has to be the traveler's calendar day; the UTC one files a
  21:00 CEST stop under tomorrow. Now derived from the local parts of `when`.
- **The datetime input is local by specification**, so pre-filling it from
  `toISOString()` would have shown a CEST traveler a time two hours early and
  invited them to "correct" it the wrong way. `localInputValue` builds it
  from local parts.
- **An emptied date field parses to Invalid Date**, and `.toISOString()` on
  one throws — which would have lost the entry at the moment of saving it.
  Falls back to now.

**And a test of mine was wrong before the app was.** The dark-mode e2e
assertion parsed `getComputedStyle().color` as `rgb(…)`, but Tailwind v4
emits `oklch(…)`, so it read `oklch(0.97 0 0)` as three 0–255 channels and
reported a contrast of 1.0 for what is in fact near-white on dark grey. The
colours were correct; the ruler was not. It now paints each computed colour
onto a 1×1 canvas and reads back sRGB, so it measures what the screen shows
rather than what the declaration said — and it asserts contrast rather than
class names, because what broke here was a computed value that any
"does it have a `dark:` variant" check would have passed.

**And the pacing banner stopped nagging.** *"Remove this top banner from
being recurring as well. It's ok on app launch, but not every time."* The
dismissal was already keyed on the warning text rather than a boolean — so
a genuinely different set of warnings could still speak — but it was held in
component state, and `PlanStrip` unmounts on every hop to Diary, Countries or
a day. "Got it" therefore bought silence until the next tap back, which is
not what dismissing something means. It lives in `sessionStorage` now, per
trip: the banner gets one say per app launch and every navigation after that
respects the answer. Not `localStorage` — a dismissal that outlived the app
would mean someone who once said "Got it" never hears about a real pacing
problem a month later. Both accesses are wrapped, since storage throws
outright in Safari's private mode, and a banner that cannot be dismissed is a
far smaller failure than a board that will not render.

Verification: lint 0, build 0, frontend **308**, e2e **138** (clean —
`corridor.spec.ts:576`, which failed on ordering in the first run of the
day, passed in the final full run).

### 2026-08-24 (later) — the day list stops being a frozen artifact

Six reports in one message, and four of them turned out to be the same
structural gap.

**Why the day strip never updated.** Two mechanisms write days, and between
them they left a hole:

- `runReconcileCorridor` rewrites days, but only from an explicit "Edit
  route" submit.
- `planSkeleton` rewrites days from the board automatically, but refuses any
  trip where a day carries detail — correct, since that detail was paid for.

So for a trip that has been generated AND had any day opened, **nothing**
recomputed the day list from the board again. The strip sat frozen,
describing whatever the last generation said. *"The list of day plans on top
does not seem to update dynamically… My intention was to not have to interact
in the same way with the day view."*

The guard stays; there is now a door beside it. `planSkeleton` takes
`rebuildOverDetail`, set only by a traveler pressing **"Rebuild day list"**,
which states plainly that researched activities and restaurants are discarded
and that each new day refills itself when opened. The automatic path cannot
set it.

**Removing a stop now takes its days with it.** `rejectCorridorStop` and
unlock wrote `status` and nothing else, leaving both the day and the stop's
`linkedDayIds` standing. That is cosmetic right up until you try to use
"Edit route", which hard-throws when the committed stops' linked days do not
cover every day in the trip — so a removal from the board could quietly make
the reorder panel unusable. `removeStopFromRoute` is the one entry point for
both buttons now: status first (a leftover day is recoverable; days deleted
for a stop still claiming to be in the route is not), then the day, its
subcollections, the renumbering, and the stale link.

**And the trips already in that state get repaired.** `staleDays` finds days
whose every owner has left the route, and the board offers to remove them.
The direction of that check is load-bearing and is the one thing in this
change that could have been catastrophic: it is NOT "days nothing links to".
Skeleton days are claimed by nobody at all, so that rule would have deleted
the itinerary of every trip that never ran a full generation. There is a test
named after it.

**The other three.** *"Need a way to undo marked done as well!"* — Undo had
shipped, on the card, and was invisible: the link carried no text colour and
inherited black onto a dark card, which is the `color-scheme` bug fixed
earlier the same day. A done card is also drawn back now, at 60% — the board
had claimed since 2026-08-23 that it "stays in the list, muted", and nothing
muted it. *"Want to be able to edit diary entries"* — entries were write-once;
`date` and `note` are now editable and an entry can be deleted, while
`refPath`, `refType` and `createdAt` stay fixed, since an entry repointed at
another place is a new entry and `createdAt` is what makes backdating `date`
safe. *"I'm not even able to get to the day view without clicking in the day
list?"* — true; a kept stop's card now offers "Open its day".

**A test of mine raced the product again, in a new way.** The cleanup
assertion clicked, checked the banner had gone, then read through the admin
SDK — and failed, with the day still present and the stop's links intact. The
cause was not the write: the Firestore web SDK applies a batch to its local
cache before the server acknowledges it, so the banner vanishes the moment
the delete is queued. The assertion passed on that local state, the admin
read ran immediately, the test failed, and closing the page killed the commit
in flight. Polling the server for the actual state fixed it, and the product
code was right all along. Worth recording next to the `oklch` parser: twice
in one day the ruler was wrong rather than the thing being measured.

Verification: lint 0, build 0, frontend **330**, e2e **141** — clean.

### 2026-08-24 (evening) — the board becomes something you use on the road

A batch of reports, and the theme running through them is that the board was
built for planning at a table and is now being used from a moving van.

**Search merged onto the map — surface only.** *"The find nearby doesn't need
to be triggered from a separate tab. Use the map view, so it's easy to see
the location of the results… it's very common to rescan area, so maybe they
should be integrated?"*

Merged: one panel, one anchor control (map centre / where we are), one radius,
and finds drawn as pins instead of listed on another tab. The `/live` tab is
gone.

**Not** merged: whether a search WRITES. Rescan writing is the point — it is
how a scan becomes stops you can curate, and the reject tombstone that stops
the next scan handing back what you turned down only works because results
are written. "Near us" not writing is equally the point: looking for lunch
three times a day would fill the corridor with pins nobody chose. One button
with a "save these?" flag would make a boolean decide whether an action
mutates the trip, which is the same shape as the mistake `searchNearby` was
split out to avoid. Two buttons, unchanged semantics, everything around them
shared.

The radius is an override **beside** the viewport, not instead of it — the
viewport default was confirmed right ("No. It was right to limit at 7 km").
The fixed 25 km floor on "near us" was the reported cause of distant results.

**Two regressions the collapsible panel introduced, both caught by the
suite and both fixed in the product rather than the test.** A scan runs for
minutes and its result outlives the panel that started it, so collapsing over
one hid the elapsed counter, the stale-scan recovery and the durable error —
undoing the whole reason `rescanError` is written to the trip. A running scan
now keeps its own button on the map, and a finished one keeps its status
line, whether the panel is open or not.

**Routing from where we are.** Gated on `isTripActiveToday` and on having a
fix, because planning a German trip from a sofa in Sweden would otherwise
route it from Sweden and every number on the board comes off that first leg.
Said out loud on the totals row, because a single bad fix would otherwise
rewrite the driving total, the budget and the arrival dates with nothing
explaining why.

The quantiser is the interesting part. `useCurrentPosition` watches rather
than samples, so it emits a fresh object per fix, and `DirectionsRoute` lists
its points in an effect dependency — a new origin per fix is a Directions
request per fix, which is the self-sustaining loop that once made this map
impossible to pan. The first version remembered the last origin and measured
against it, which needed a ref written during render; React forbids that and
lint caught it. Snapping to a ~1 km grid is pure: the same fix always yields
the same cell, so a `useMemo` on two rounded numbers gives stability with
nothing remembered anywhere.

**Estimated arrival dates**, from the packing that already exists, counted
from TODAY once the trip is running — an estimate confidently behind the
traveler is worse than none — and overridden by a real day's date wherever
one exists, because two things claiming to say "when" is how the header and
the itinerary came to disagree before. Writing the test caught a wrong
assumption of mine: `packStopsIntoDays` does not drop done stops, `tripBudget`
does that before calling it, so a function promising "what is left" had to do
its own filtering rather than trust every caller.

**Done stops leave the planning list**, checked and greyed on the map. This
reverses the earlier call to keep them muted in the list, and the reversal is
right: on the road the list is a to-do, not a record. Undo lives on the card,
so removing the card would have removed the undo requested in the same
breath — a done stop's pin therefore renders its card when tapped, and "Show
done (N)" brings them all back. Worth noting that nothing had actually marked
a done stop on the map before this: they drew the same lightbulb as
everything else, and the dimmed card was the only signal.

**Also**: spaces and Enter reaching a card's own fields; the diary ordered by
when things happened rather than when they were typed; the diary carrying the
place's photo for free; and the header down from six stacked rows to three,
dropping the generation-time km/avg figures that disagreed with the live ones
beside them.

Verification: lint 0, build 0, frontend **350**, e2e **142**
(`dayview.spec.ts:140` flaked in the full run and passes in isolation — the
known ordering flakiness).

### 2026-08-24 (late) — the list follows the route, and Claude leads the search

**The candidate list is in driving order now.** *"The list is not updating
according to the logical chronological order, not even when locked in."*

It was sorted by `sortAlongRoute`, which projects every stop onto the
straight line from the trip's start to its end and sorts by that one number.
For a loop or an out-and-back that scalar says almost nothing, and the drive
order is not recoverable from it — the same failure `guessedOrder` already
carries a note about, where a projection sent a trip north through Sweden to
reach Estonia. The real order was sitting unused: `routeStops` IS the driving
order, and it already draws the route line, the leg rows and the arrival
dates. The list was the one thing re-deriving a worse order from scratch,
which is why it disagreed with everything around it. Unkept candidates take
the place they WOULD have, via `findCheapestBackboneLeg` — the same function
behind the "≈+41 km" badge, so a card's position and its advertised detour
cannot disagree about which leg it belongs to.

**Three of the six tests I wrote for that proved nothing.** Run against the
old projection they gave identical answers, so they would have passed before
and after. Replaced with an out-and-back — south to Verona, back north to
Innsbruck, then Venice — which the projection gets demonstrably wrong
(`innsbruck,verona`) and the route order gets right. Verified by running the
old function against the same coordinates rather than by reasoning about it.

**Claude now leads every search, with Places as the fallback.** *"Don't
expect to find pizza when I search all of Italy for things to do. Also, the
good descriptions and pictures were dropped… I'd also like the std Claude
search to be default also for zoomed in, and places if nothing is found."*

Both halves were structural, not incidental:

- **The blurb.** The Places branch describes a find with `describePlace` —
  its Google summary, its star rating, "Matched your search: …". That is the
  generic-description complaint from 2026-08-18, and the board-rework notes
  name wiring anything new to it as the trap to avoid.
- **The photo.** The Places branch never set `photoUrl` at all. Not a lookup
  that missed — a field it never populated. Pictures were not dropped from
  that path; they were never reachable down it. The Claude path verifies
  every find through `verifyPlaceLocation`, which is where a photo and a
  listing link come from.

And a text search takes the query literally: "something worth doing nearby
right now" over Tuscany returns the Tower of Pisa, because that is what
ranks — not because anyone weighed it against a family that came for
mountain biking.

The latency that set the original order was a Claude path running WEB
SEARCH, which took minutes and blew the client timeout. That tool was
removed in August; what remains is one tool-free turn plus verification.
Slower than Places, nowhere near the failure that set the order.

Half the reported regression was mine and had nothing to do with the server:
the merged search panel had `why` and `photoUrl` in hand and rendered
neither. A result you cannot judge is not a result.

**An existing e2e test caught a real regression in the inversion, and my own
new test had encoded the wrong behaviour.** With Places first, a search in a
credential-less environment ended in a rejected promise and an error banner.
With Claude first, each failure was caught on the way to the next path, and
the traveler was told "nothing found in that circle" — advice to widen a
search that never ran. A search that broke must never read as a search that
found nothing, so both engines erroring now throws. Note the condition:
Claude answering "nothing here" is a real answer even if Places then falls
over.

**On the zoom limits, since they were asked about:** there is no gate that
switches engines by zoom, and after this change Claude runs at every radius
including the smallest. What exists is a 1 km floor and a 150 km cap
(`MAX_RESCAN_RADIUS_KM`), the latter a quality bound rather than a cost one.
Worth noting the two halves of the report pull against each other: searching
all of Italy for "things to do" is exactly the question the cap exists to
prevent.

Verification: lint 0, build 0, frontend **356**, functions **646**, e2e
**142** — clean.

### 2026-08-24 (last) — the header again, this time for a phone

*"The iPhone view is now very limited for scrolling the list at the bottom.
The top should be further compacted!"*

The header was compacted for an iPad earlier the same day and measured
there. At 390px the same five actions wrapped the row three times over and
the totals took two more lines, so the list — the thing you actually curate
in — was left with a couple of card-heights.

Fixed responsively rather than by shrinking everything: the three plan
actions sit inline wherever they fit and collapse behind **"More"** where
they do not, at Tailwind's own `sm:` breakpoint, so no JavaScript decides
layout and there is nothing to keep in sync. The two longest labels get a
short form on narrow screens ("Full plan (23)"), the word "driving" — which
earns nothing beside a distance — drops out, and "from where we are" becomes
"from here".

Measured, not assumed: at 390×844 the actions row is one line (57px), the
totals one line (33px), and the list **280px**, up from roughly 150. The new
spec asserts those by bounding box, the same call the iPad split test makes,
because what breaks here is a layout that computes wrong rather than a
utility that goes missing. A tablet case asserts the opposite — everything
inline, no "More" — so a phone-shaped fix cannot quietly undo the row that
was asked for in the first place.

Two test corrections of my own, both mine rather than the product's: an
assertion that "Rebuild day list" appears behind the disclosure was a claim
about the FIXTURE (whose stops are all `committed`, while that button is
offered only where there are locked stops to rebuild from), and the existing
44px tap-target test had to learn that the button it measures now lives
behind a disclosure — which is itself a tap target, so both are measured now.

**And then the two primary buttons came down to 36px** — reported as
"unreasonably big" on the phone.

Worth stating rather than hiding, because it reverses an argument made
earlier the same day. A first pass shrank every button on that row, the
tap-target suite caught it at 36px against a 44px floor, and it was restored
on the reasoning that compactness should come from deleting rows instead.
Two things changed after that. The rows ARE deleted now — the plan actions
collapse behind "More" — and 36px is what every other control on this screen
already is, from the interest chips to "We've done this", so 44px on these
two was the odd one out rather than the standard.

The full height stays where it earns its keep: the nav links, and the plan
actions revealed behind the disclosure. "More" itself keeps it too, which is
why the row still measures 57px — it is a text-only button whose height is
hit area rather than visible pill, so a taller target sits beside smaller
pills at no visual cost. The e2e suite still measures all of those.

Verification: lint 0, build 0, frontend **356**, e2e **145** — clean.

### 2026-08-25 — search results become things you can actually use

*"Search is still broken. Results are just shown in a small list, not on map
properly. Even worse, results added to the map are not possible to interact
with, even though they have been added to the trip. At restart, the added
results are gone."*

Three symptoms, two confirmed defects, and one claim that needed a test
rather than an argument.

**Results in a 288px overlay.** Mine, from moving the search onto the map: the
results came with it, into a panel with room for a name and a button. A find
carries a photo and a paragraph about why it suits this trip, and neither
fits there. Results now render in the list below the map, in the same column
and the same shape as the stops they might become — dashed rather than solid,
because that is the one real difference: nothing is part of the trip until it
is added. The panel keeps only the controls and a one-line count.

**Find pins were decoration.** They had no `onClick` at all, on a map where
every other pin opens something. They select now, highlight their card, and
scroll it into view — the same treatment stop pins have had since the card
list existed.

**And the added find left a dead pin on top of the live one.** After "Add",
the find stayed in the ephemeral list, so two pins sat at the same
coordinates: the new interactive stop, and the search result covering it with
nothing to open. That is exactly "added to the trip but not possible to
interact with". A saved find is retired from the ephemeral list now, handing
the spot to the pin that does something.

**"At restart, the added results are gone" could not be settled by reading**,
so the write moved out of the screen into `addFind.ts` with a test that pins
what it writes, and an e2e test drives the resulting stop through a reload:
it renders a card, the card's actions work, and it is still there afterwards.
The write was correct. What was gone at restart were the ephemeral 🔎 pins,
which vanish by design — indistinguishable, from the outside, from a save
that failed. The three UI fixes above are what make that distinction visible.

One hardening while in there: optional fields are spread conditionally rather
than passed as `undefined`, since Firestore rejects an undefined field value
outright — a find with no photo would have thrown and taken the whole add
with it, which is precisely the shape of "it said Added and then it was
gone."

Verification: lint 0, build 0, frontend **361**, e2e **146**
(`dayview.spec.ts:140` flaked in the full run and passes in isolation).

### 2026-08-25 (later) — a filter for the list, and why locked days do not exist

**A filter, with two buckets beyond the four asked for.** *"Selecting only
locked in, only must see, only not locked in or all. Add more if that makes
sense."* Both additions replace something rather than piling on:

- **Done** folds in the "Show done (N)" toggle from the day before. Done
  stops leave the planning list by request, and a second, differently shaped
  control for getting them back was one mechanism too many.
- **No day yet** answers the other half of the same message. Counts come from
  the same predicate that does the filtering, and empty buckets are not
  offered — a chip reading "Done (0)" is a control that can only disappoint.

**"I don't know how to get to that view for the locked in days. I feel like
that should auto generate. Possible?"**

It already does — and the reason it had not for this trip is worth stating,
because the honest answer is not "yes" or "no".

Locking a stop in does not create a day. Days come from `planSkeleton`, which
derives them from the kept stops for free and writes them automatically. It
holds off on exactly one condition: a trip where any day carries researched
detail. That guard is right — that detail was paid for, and silently
discarding it would be far worse than the missing day — but its consequence
was invisible. A locked stop simply had no way into Day View and said nothing
about why.

So the card says it now: **"No day yet — build the day list"**, which opens
the same panel that has been on the header since yesterday. Fully automatic
generation over researched detail is the one thing deliberately NOT done: it
would mean a background effect deleting activities and restaurants because a
stop was locked. The button is one tap and says what it discards.

Offered only where it can work — `days.length > 0`, since the panel lives in
PlanStrip and PlanStrip only renders once the plan has days. With no days at
all the skeleton writer is about to make some unprompted, which is the case
that already worked.

Verification: lint 0, build 0, frontend **369**, e2e **147** — clean.

### 2026-08-25 (evening) — detail is bought by asking, not by looking

*"I want to generate the bare minimum for the days, the locked in activities
for the day… it should have the same structure as previously generated days,
just that the content could be generated for it with a click on that empty
header (lunch) for instance. I want it more dynamic."*

Two thirds of that already existed as "Rebuild day list". The third turned
out not to be a nicety but the thing holding the other two up.

**Why the dynamic day list kept dying.** `DayDetailGate` fired `detailDays`
the moment a day was opened — that day and the two after it — which sets
`detailStatus: 'ready'`, which is exactly what `planSkeleton` refuses to
rebuild over. So a traveler could rebuild a clean list derived from their
locked stops, OPEN one day to look at it, and find the list frozen again.
**Detail was being bought by looking.** Nothing was wrong with the guard; the
spending was in the wrong place.

So the gate no longer asks. Each empty section offers to fill itself, and the
gate offers the whole day for anyone who wants all of it. Opening a day costs
nothing, and the list stays derived from the stops for as long as nobody
spends anything on it. An e2e test holds that line: opening a pending day
must leave its `detailStatus` and `detailError` untouched.

**The new callable is not a smaller `detailDays`,** and the differences are
the design:

- It **never touches `detailStatus`** — a day with only its lunch filled is
  not "ready", and saying so would both lie and stop the whole-day pass ever
  running on it.
- It records **`filledSections`** instead: the day-document signal that
  something here was paid for. It lives on the day rather than being counted
  from subcollections because `planSkeleton` is what needs it, and that runs
  on the client against day docs only.
- It **replaces only its own scope.** `detailDays` clears a day's activities
  AND restaurants before writing, which is right for a whole-day pass and
  would have destroyed the other three sections here.
- **Deterministic document ids** (`lunch-0`, `activity-3`), so two taps that
  race cannot each delete the old scope and then add their own three, leaving
  six.

**A separate prompt, not a narrowed one.** `DETAIL_SYSTEM_PROMPT` is tuned,
sits in the paid whole-trip path, and its shape is "exactly 5 activities and
exactly 9 restaurants" — editing it to take a category would put every full
generation at risk to serve a button. The new one asks a smaller question.
What must not drift between them is the anti-generic-blurb rule, since
`researchMoreAlternatives` fills sections from Places with a template
sentence and that is what produced the "quite generic" complaint in August;
a test asserts both prompts still carry it, phrase by phrase.

**A leak found on the way.** `writeSkeletonDays` deleted day documents but
not their `activities`/`restaurants`/`overnightOptions` subcollections.
Firestore does not cascade, so every rebuild since that function existed has
orphaned them. It now reads and deletes the contents first, the same shape
`applyDayCleanup` and `writeGeneratedDays` already use.

Two fixture mistakes of mine, both caught by the suites rather than by
reasoning: the callable test's mocked places had no coordinates (those are
what `enrichDayDetail` adds, and the schemas require them), and the prompt
test's outline day was missing its `highlightReason`.

Verification: lint 0, build 0, frontend **372**, functions **660**, e2e
**149** (`map.spec.ts:33` flaked in the full run and passes in isolation).

### 2026-08-25 (late) — the strip starts at today, the map opens on us

*"The days on top are still som old irrelevant stuff. I want info about
today, tomorrow and so on… the default map location seems to be start point.
Make this gps location at like 50 km edge to edge on screen."*

Both are the same complaint in two places: on day twelve of a trip, the app
opened on day one.

**The day strip is anchored to today.** "Today" and "Tomorrow" carry the two
days anyone acts on; past that a date beats a day number, because nobody
counts to seventeen to work out when they are somewhere. Days behind you are
hidden, not deleted — "where did we sleep on Tuesday" is a real question — so
they sit behind a "← 3 earlier" chip. Before the trip starts, and after it
ends, there is no "today" inside it and the strip stays exactly as it was:
Day 1, Day 2. Relabelling a finished trip's last day "Today" would be a lie.

**And when the days genuinely are old**, the board now says so. That was the
literal case here: days left over from an earlier full generation, while six
locked stops had no day at all. The automatic writer cannot fix it on its own
— those days carry researched detail, and discarding it silently would be far
worse than the stale strip — so there is a banner that counts the kept stops
the day list has never heard of, with the one button that can.

**The map opens on the GPS fix at ~50 km across.** ONCE, which is the whole
subtlety: a watch reports a fix every few seconds, and re-centring on each
would drag the map out from under anyone looking somewhere else — the same
class of fault as the render-time pan that once locked this map up entirely.
So it fires on the first fix, never again, and declines even that if the
traveler has already moved the camera. `onDragstart`/`onZoomChanged` mark
that rather than `onCameraChanged`, which cannot tell a gesture from our own
`moveCamera`.

The zoom is computed rather than constant, from the map element's real width
and the latitude. Google's metres-per-pixel carries a `cos(latitude)`, so a
fixed zoom means "50 km" only somewhere in between — it covers about a third
less ground in northern Norway than at the Mediterranean. The test asserts
the SPAN the resulting zoom actually covers, at three latitudes and two
screen widths, rather than pinning a magic number: the number is only right
if the span is.

**And a way back.** *"I want a button to go to my location. Then the zoom
could be like 5 km."* The opening view fires once and never again, by design,
which left no route back after a pan. The button closes that, closer than the
opening view on purpose: opening wide answers "where am I in this trip",
pressing this answers "what is around me right now", and 5 km is about the
next twenty minutes of driving rather than the next two hours.

It reaches the map by `id` through `useMap`, because the overlay controls are
positioned siblings of the `<Map>` element rather than markers inside it, and
the whole screen sits under one APIProvider. It disappears entirely once
location is refused — a permanently dead control is worse than no control —
but only stays disabled while the answer is merely unknown.

**A test of mine was unachievable before it was wrong.** The first e2e
version asserted the button becomes enabled once a fix arrives. It cannot, in
CI, at any level of correctness: `useMap` returns null without a live Google
map and the test browser has no Maps key. Moved to a unit test against a
stubbed map, with e2e asserting only presence — the same split MarkerBadge
already uses, and the same trap that caught the position marker in August.

Verification: lint 0, build 0, frontend **389**, e2e **154** — clean.

### 2026-08-25 (last) — the order stops moving, and the list knows what it is for

*"For some reason, it made the locked in stops earlier. The list should be
locked in not done, starting with what is first on the route."*

**The reordering was mine, from that morning.** Once the route was drawn from
the traveler's own position, Google was optimising from there too — which
re-answers a different question every few kilometres ("the best order from
HERE" rather than "the best order for this trip"), so a stop that was first
stopped being first the moment it was passed. Worse, a stored order is keyed
on the SET of stops and not on where it was worked out from, so an order
optimised from a lay-by is indistinguishable from one optimised at the start
line and gets applied just the same.

So the ORDER is a property of the trip, decided from its start point, and the
position only decides where the drawn line begins. `mayOptimize` takes that
second condition now.

**And the list defaults to what is kept and still ahead — but only on the
road.** That took three attempts, each corrected by the suite rather than by
argument:

1. A fixed `'locked'` default showed an empty list on a trip that had just
   found its first twenty candidates — the screen whose whole job is
   curation. Nineteen specs said so at once.
2. Deriving it from "is anything locked" was worse in a subtler way: locking
   your FIRST stop then made the other nineteen vanish mid-curation. One spec
   caught that, by trying to reject a stop it could no longer see.
3. `isTripActiveToday` looked right and is not: a trip created this morning
   spans today by default, so it fires during curation too.

The signal that holds is `origin.fromPosition` — routing from the traveler's
own position, which needs the dates AND a real fix. That is as close to "on
the road" as this screen can get, and it is already computed for the route.
Once the traveler picks a filter themselves, their choice stands.

Verification: lint 0, build 0, frontend **392**, e2e **156**
(`dayview.spec.ts:140` flaked in the full run and passes in isolation).

### 2026-08-26 — a stop behind you is not the next one

*"Now the order is wrong again. I feel it should start working out the order
from my position, just treat that as the current starting point. Now it's
jumping around, for some reason putting Kronplatz ahead of Seiser Alm, even
though we are at Seiser Alm."*

Yesterday's fix — disabling optimisation while routing from the traveler's
position — was wrong, and wrong in a way only the road showed. With Google
not reordering, the order fell back to `guessedOrder`, a straight-line
projection from the trip's START point, which ignores where the van is
entirely. Stopping the optimisation removed the thing that had been
correcting a bad guess. Reverted: optimisation happens wherever the route
starts from, and `routeOrderKey` now carries the ORIGIN so an answer worked
out in one valley is never applied in another.

**Moving the anchor to the van was not enough on its own**, and only writing
the test showed why. `sortAlongRoute` sorts by scalar projection onto the
origin→end line, and a stop BEHIND the origin projects NEGATIVE — so it sorts
before everything ahead. Standing at the Seiser Alm with the route running
south-west, Kronplatz to the north-east projected to a negative number and
was presented as the next stop. Exactly as reported, and the first version of
the test asserted the anchor alone would fix it. It does not.

`orderStopsFromHere` is the rule that does: what is ahead first, in
projection order, then what is behind, ordered by how far back it is —
because turning around, the nearest thing behind you is the first you reach.
A stop you have passed is still yours; it is just not next. A test asserts
the plain projection still gets it wrong, so nobody simplifies this back to
it.

Verification: lint 0, build 0, frontend **400**, e2e **156**
(`corridor.spec.ts:760` flaked in the full run and passes in isolation).

### 2026-08-26 (later) — Today names the next stop, and the map stops shouting

*"'today' should reflect the closest not marked done activity. Now it's some
other far away location. On iPhone, the map keeps being to dominant."*

**Today now names what the van is heading to.** The chip read its day's
`overnight.name` — an overnight town from an older plan, which for this trip
meant "Castello Scaligero di Sirmione" on a screen 200 km away at the Seiser
Alm. It takes the first entry of `routeStops` instead, which after the
morning's ordering work IS the closest stop still to do: that list is ordered
from the van, excludes anything done, and puts what is behind you last.

Only Today. The days after it are the plan's answer to "where will we be";
this one is the road's answer to "where are we going", and they are different
questions.

**The map is 35vh on a phone, 45 from `sm` up.** At 390×844 it was taking
380px of a screen that had already given a third of itself to the header, so
the list — the thing actually curated in — got what was left. The floor stays
at 220px, because a map smaller than that stops being a map and becomes a
texture. Measured: the stop list goes from 280px to **365px**, and the
existing geometry assertion was raised from 240 to 330 so it holds the new
line rather than the old one.

Verification: lint 0, build 0, frontend **400**, e2e **157** — clean.

### 2026-08-26 (last) — the strip reads the board, not an old plan

*"It shows Seiser Alm as previous even though we haven't marked it done. Same
with next locked in stop on the map, Kronplatz, is also shown as earlier,
even though it's clearly marked as next on the map."*

Both halves were one thing, and the previous fix was a plaster on it. The
strip is a VIEW of the `days` collection; on this trip that collection is
left over from an older generation, so it dated Kronplatz to two days ago
while the board — correctly, after the morning's ordering work — had it as
the next stop ahead. Relabelling the "Today" chip fixed one entry and left
every other one saying the same wrong thing.

So when the stored days no longer describe the kept stops, the strip stops
reading them and reads the board: the stops in the order they will be driven,
dated by their arrival estimates, with the first one Today. Nothing is
written — the stored days still hold the researched detail, and rebuilding
them stays the traveler's choice. A chip with no day behind it opens the
rebuild rather than navigating nowhere.

The condition is the one already on screen: `daysMissingKeptStops`, the same
count the "these days are from an earlier plan" banner reports. When the days
and the board agree, the strip goes on showing the real days, with their real
overnight towns and their past-days reveal — a generated plan has connecting
nights that are nobody's kept stop, and deriving would lose them.

Verification: lint 0, build 0, frontend **404**, e2e **157** — clean.

### 2026-08-26 — one rebuild button, and one number

*"Now there are two rebuild days on the same screen. Which to push? Should
both be there?"*

They were never two actions — one opened the confirmation and the other was
the confirmation — but nothing on screen said so, because the trigger stayed
up looking exactly like an unpressed button beside the panel it had already
opened. Both triggers (the out-of-step banner's and the header's) now stand
down while the panel is up, and come back when it is dismissed.

**And the same screen was contradicting itself about how many stops it was
talking about**: the banner said thirteen kept stops were missing from the
days while the panel underneath offered to build from six.
`stopsAddableToRoute` was counting stops already marked done — which need no
day and cannot be added to a route, being behind you. It filters them now, so
the count the banner reports is the set the rebuild actually uses.

Verification: lint 0, build 0, frontend **406**, e2e **158**
(`dayview.spec.ts:140` flaked in the full run and passes in isolation).

### 2026-08-26 — the rebuild says what it did, and links what it wrote

*"Previously clicking the button gave no visual confirmation/progress info.
Is that also available now? Else build it."*

It was not, and building it turned up why the button had felt inert. The
rebuild showed "Rebuilding…" on the button itself and then closed its panel,
which is the same thing the Cancel button does — so a traveler who had just
been warned that this discards researched detail was left to infer success
from a day strip they were already unsure about. There is now a progress line
while it runs and a result banner after: *"Day list rebuilt — 4 days from
your 6 kept stops. Open a day to fill it in."*

**The banner it was offered to fix survived it.** Writing that assertion into
the test is what exposed it: `writeSkeletonDays` wrote the days and never
touched the stops, so every kept stop still had an empty `linkedDayIds`, and
`stopsAddableToRoute` — "is this a kept stop with no day" — went on counting
all of them. The "these days are from an earlier plan" banner therefore stood
unchanged after a successful rebuild, which is indistinguishable from the
rebuild having done nothing. It was not a missing-feedback problem alone;
the action really had left half its job undone since the skeleton path
landed.

Which stop lands on which day is known only inside the packing, so it comes
back out with the days as `stopIdsByDay` and both halves — the day documents
and the stops' `linkedDayIds` — go into the same batch. A basecamp's extra
nights carry no `stops` of their own (the stop sits on the first night), so
`parkedAt` links the rest of them; without that the extra nights would claim
nobody. The automatic writer passes the same mapping, and its
write-once signature now includes the stop ids, since the same run of dates
can be reached with a stop on a different day.

One e2e fixture needed correcting rather than the code: the seeded plan's
days carry activities and restaurants but no `detailStatus`, so the automatic
writer treated them as its own and rebuilt over them. Marked `ready` — which
is what a generated day really carries — the filter test's locked stop is
genuinely day-less again, which is the case that bucket exists for.

Verification: lint 0, build 0, frontend **408**, functions **660**, e2e
**159** — all green, no flakes.

### 2026-08-28 — the search was right; the account was empty

*"The results seem to be based solely on Google Maps results again?"*

They were, and nothing in the code had regressed. The production log for that
minute says it outright:

    {"event":"query_search","source":"places","finds":8,"claudeMs":560,
     "claudeError":"400 … Your credit balance is too low to access the
     Anthropic API."}

— against the previous evening's entry for the same trip,
`{"source":"claude","finds":5,"claudeMs":12736}`. The Claude-first order
inverted on 2026-08-24 is intact. The Anthropic account ran out of credit,
Claude refused in half a second, and the Places fallback answered with its
own template blurbs and no photos, exactly as designed.

**The bug is that it did so in silence.** A correct fallback nobody can see
is indistinguishable from the regression it looks like — same generic
descriptions, same missing pictures — and telling the two apart took a Cloud
Logging query, which is not something a traveler parked at Lake Garda can
run. The instrumentation added on 2026-08-24 is what made the diagnosis take
minutes instead of an evening; it was pointed at the wrong audience.

So the reason now travels with the result. `findStopsForQuery` returns which
engine answered and, when Claude failed, a coarse kind — `credit`, `auth`,
`rate-limit`, `timeout`, `other`. Those five exist because each has a
different answer for whoever reads it: a card to top up, a key to fix in the
deployment, a minute to wait, a retry. Anything else stays "it could not be
reached" rather than being guessed at.

Two distinctions the encoding protects:

- **A fallback is not an error.** The eight places still come back and still
  go on the map. Withholding real results near a traveler on the road to
  make a point about billing would be the wrong trade; the note sits beside
  them instead.
- **"Nothing here" is not "we are down".** Places answering after Claude
  proposed nothing carries no failure kind at all, because Claude having
  nothing to add is a fact about the ground, and reading it as an outage
  sends someone hunting a bug that does not exist.

The typed-query rescan records the same reason on the trip
(`planMeta.rescanLastClaudeFailure`), deleted on any run that did not fall
back — the same discipline `rescanLastError` already follows, so a fixed
problem stops being reported the moment a search works again. The plain
"rescan this area" pass needs none of this: it is Claude or an error, and it
already says which.

Verification: lint 0, build 0, frontend **413**, functions **664**, e2e
**159** — all green.

**Open, and not a code problem:** the Anthropic account needs credit before
the richer search comes back. Until it does, every Claude-backed feature —
day detail, corridor research, plan generation — falls back or fails; only
this search had a fallback to fall back to.

### 2026-08-31 — a scan that wrote to a list nothing rendered

*"Used rescan this area. Said it found 7 results. Can't see any. What differs
rescan this area to find something to do? Also, strange date for current
stop."*

Three findings, and the first one was not the filter it looked like.

**The rescan wrote seven stops into a status the board could not show.**
`runRescanCorridor` writes `status: 'candidate'` while a trip has no plan and
`'proposed'` once it has one — and `ExploreMapScreen`'s list was built from
`candidate` and `locked` alone. So on any trip past generation, every rescan
find was invisible in **every** bucket, "All" included; the counts never grew
because they are computed from the same array. The count on the map was
truthful — it is the length of the batch the callable awaits — and pointed at
a list that structurally could not contain its results.

`ExploreCandidateCard` has rendered "Lock in" for a `proposed` stop since the
board became the Map tab at every plan status: the card was answering a
situation one line in the screen made unreachable. The status keeps its
meaning — a rescan finding on an already-generated trip, still to be reviewed
— it just has somewhere to be reviewed now.

**And the filter could hide them a second time.** The screenshot's list was
on "Locked in", which a stop written seconds ago can never be: fresh finds
are never locked, never done, never must-see, and have no day, so only "All"
and "Not locked" can hold one. `filterShowsNewStops` derives that rather than
listing it, and the scan's own result line now says where its finds went with
a one-tap "Show them". A count the traveler cannot reconcile with what is on
screen is worse than no count.

**"What differs rescan this area to find something to do?"** Nothing on the
panel said, and the two do opposite things with their results: the preset
buttons are a scratch list that writes nothing until you add something, the
rescan writes straight into your stops. One line under the divider now says
so — the question was asked because a horizontal rule is not an explanation.

**The date.** A stop on the route ahead, not marked done, showing 2026-08-20
— eleven days in the past — directly beneath a banner reading "These days are
from an earlier plan". Both sentences came from `arrivalEstimates`: a
committed day won outright over the packing, and the day it won with belonged
to a plan the traveler had already driven past. A past day on a stop nobody
marked done is not a commitment, it is residue, and the packing — which
counts forward from today — is strictly better informed about a stop still
ahead. So a committed date wins only while it is still ahead; done stops are
filtered before this point, so it cannot swallow a real date something was
done on. The day strip reads the same estimates, so its chips stop mixing
last week's dates with next week's in one row.

Verification: lint 0, build 0, frontend **417**, functions **664**, e2e
**161** — all green.

### 2026-08-31 — the rebuild stops throwing away the research

*"What's up with this rebuilding warning? Does it have to warn? What does it
have to discard? Can it not just keep already generated days available, if
they would be done at a later point in time?"*

The warning was honest — the code really did delete every day and every
subcollection — but the code was destroying things it had no reason to
touch. **A day's researched activities and restaurants belong to the PLACE
the day is spent in, not to the date it was given.** A lunch spot in Riva del
Garda is still a lunch spot in Riva del Garda when the day moves from the 2nd
to the 4th. The old rebuild deleted everything because it matched old days to
new ones by nothing at all — it had no notion of "the same day" — so a
reorder read as a total replacement.

`planSkeletonWrite` matches them by overnight, on two keys tried in order:
the name, folded the way stop names are folded; then coordinates at 2dp
(≈1 km), for the generated day whose overnight moved off the town centre onto
a campsite and took the site's name with it — "Lillehammer Camping" against a
stop called "Lillehammer" is the same place wearing a different label.
Claimed greedily and at most once, so a basecamp's three nights match three
stored days rather than all three claiming one.

A reused day **takes** its place in the itinerary — `index`, `date`, `type`,
the drive leg into it — and **keeps** everything else by the write never
mentioning it: `detailStatus`, `filledSections`, `townAnchor`, `sights`, its
activities and restaurants, and its `overnight`, which may carry a campsite
suggestion or a free-camping rule the skeleton has never heard of. Its
summary survives too when the day has detail, because that sentence describes
the research rather than the route.

**And it keeps the diary.** Firestore ids are what a log entry's `refPath`
points at, so every id-churning rebuild silently left diary entries dangling
at addresses nothing occupied. A reused day keeps its id, so the entry keeps
its subject — asserted end to end rather than argued.

Only days whose place is genuinely off the route are deleted, with their
subcollections, and the panel now says what THIS rebuild costs instead of
warning in general: nothing at all for a plain reorder, and "1 day no longer
on the route is dropped" when there is something to drop. The count comes
from the same function that does the write, so the sentence and the write
cannot disagree — the discipline `packStopsIntoDays` and `tripBudget`
already share.

**One consequence worth stating**, found while writing it: the "unchanged"
check had to move to the same matcher. Comparing overnight names directly was
right while every day was rewritten from scratch and wrong the moment days
could be reused — a day reused under its campsite name reads as changed
forever, which is one pointless rewrite per visit to the map.

The day view already carries the per-section fills (activity, breakfast,
lunch, dinner) and the overnight picker; what was missing was a way to reach
a usable day without paying for the rebuild first. That is what this removes.

Verification: lint 0, build 0, frontend **425**, functions **664**, e2e
**162** — all green, including `dayview.spec.ts:140`, which has flaked
before.

### 2026-08-31 — advice about days already driven, and a pin worth looking at

*"This list on top seems completely obsolete!"* — and *"when adding a stop
ourselves through add stop from a google location, add its photo and brief
description as well. Do not overwrite our own description!"*

**The pacing advice had no idea time had passed.** Five warnings about Day 1
(2026-08-20, Rothenburg ob der Tauber), Day 2 (Neuschwanstein), Day 6 (Lake
Lucerne), read from a campsite in the Dolomites on the 31st. Every one was
true when it was written and every one described a day the traveler had
driven past a week and a half earlier, on a route through Germany.
`planMeta.pacingWarnings` is written once by generation and then simply
persists.

What makes them expire rather than merely age is what pacing advice IS: a
decision — *"either the drive moves to another day or the sight does"* —
and that decision can only be taken before the day happens. Afterwards the
same sentence is asking the traveler to rearrange the past. So a warning
naming a date behind us is dropped, today still counts (the day is being
lived, and moving this afternoon's sight to tomorrow is a real option), and
a warning naming NO date is kept — the whole-trip observations ("the second
half carries most of the driving") never went stale, and guessing at a
sentence we cannot read would throw away the useful ones to be tidy. A
rebuild also clears the list outright, since the days those sentences
measured no longer exist and keeping them would assert something nobody
measured.

One e2e had to change with it, and was wrong in the same way: it seeded a
warning dated 2026-07-11 and asserted the banner appears. Dated ahead now —
what that test is about, a back-loaded trip being flagged and the notice
staying dismissed, is unchanged by which day it names.

**A pin dropped by hand carried nothing.** Name and coordinates, sitting in
the list beside researched candidates that each show a photo and a
paragraph — visibly the poor relation, for no reason other than that nobody
had asked Places for the rest of what the same lookup already had in hand.
The autocomplete now also reads the photo, Google's editorial blurb, the
rating and the listing link, and the stop is written with all four.

The emphasis in the request is the rule, so it is named and tested by name:
`stopDescription` returns whatever the traveler typed, untouched, and
consults Google only for a field left genuinely empty. The extra fields are
opt-in per call site — they sit in a dearer Places billing tier, and Trip
setup's start and end points have no use for a photograph — and they are
dropped alongside the coordinates when the field is edited away from a
resolved place, since a photograph of the place you just typed over is worse
than none.

Verification: lint 0, build 0, frontend **436**, functions **664**, e2e
**163** — all green.

### 2026-08-31 — the day wears the picture the traveler chose it by

*"Also carry the overview pic from planning in as a header picture for day
view."*

The photo already existed and Day View simply never asked for it. It is the
one on the stop's card in the planning list — fetched when the stop was
curated, found by a rescan, or (since this morning) pinned by hand — so a day
built around a place the traveler had been looking at a photograph of all
week opened as a wall of text.

`linkedDayIds` is the link: the stops that claim a day are the stops the day
is FOR. Two rules where several claim it, and both exist because the
alternative is visibly wrong:

- **The one the day is built around wins**, matched against the day's own
  overnight name (folded across the diacritics Places and Claude disagree
  about). On a basecamp day claimed by the lake and the cable car, the lake
  is the reason you are there.
- **Otherwise the first by name.** Firestore returns documents in no order
  the traveler can see, so without a tie-break the same day would show a
  different picture on every load.

Deliberately **not** falling back to an activity's photo when no stop carries
one. Those are places inside the day rather than the reason for it, and a day
headed by a photograph of its lunch restaurant is a worse answer than a day
with no header photograph — the same call DiaryScreen's rows already make.

Verification: lint 0, build 0, frontend **442**, functions **664**, e2e
**164** — all green.

### 2026-08-31 — a rebuild that costs nothing stops asking

*"This warning is still showing."* — with the panel circled in red.

It was, and the mistake was mine: asked that morning whether the rebuild had
to warn, I made the warning *accurate* instead of making it *go away*. The
panel then sat across the top of the screen saying "Days you have already
researched keep their places — nothing is discarded. Only their dates move."
Two lines of reassurance, occupying the same space, still stopping the
traveler to press a second button. A warning about nothing is still a
warning.

**The panel IS the warning.** A confirmation step exists to let someone
refuse, and there is nothing to refuse when the rebuild re-dates days and
keeps every researched place. So a rebuild whose cost is zero simply runs —
one tap, a progress line, the result banner — and the panel survives for the
one case that earns it: a day whose place has left the route, whose research
really does go with it. Its copy is a plain statement of the loss again,
because that is now the only time it is shown.

The cost is computed whether or not the panel is open (it was memoised on
`rebuildOpen` before, which would have made this circular), and a ref guards
the auto-run so a re-render mid-write cannot start a second one. The progress
line moved out of the panel, since the path that skips the panel is now the
usual one.

Three e2e tests encoded the old flow and had to say what they actually mean:
two now assert that a free rebuild produces a result with **no** panel, and
the one about the two-triggers problem seeds a researched day off the route
so there is something to confirm at all.

Verification: lint 0, build 0, frontend **442**, functions **664**, e2e
**164** — all green.

### 2026-08-31 — days that keep themselves current

*"Fix it and remove having to rebuild days. I want days to organically create
themselves based on the planned activities and their duration continuously.
For days with several activities, the header photo should be the activities
next to oneother."*

**The guard was aimed at a problem that no longer existed.** The writer that
derives days from the board refused whenever ANY day carried research —
correct while a rebuild deleted every day and every subcollection, and wrong
the moment days are reused by overnight, because it forbade the safe case
along with the unsafe one. On a generated trip nothing recomputed the day
list from the board ever again, which is why a traveler ended up pressing a
button to keep their own itinerary current.

It now asks the narrower question the confirmation panel already asked:
**would this particular rebuild discard research?** Zero — the usual case —
and it writes. More than zero, and it stands aside for the person to decide,
which is the only thing the button and the "these days are from an earlier
plan" banner are still for. Both disappear when there is nothing to approve.

**Three things had to be made safe first, because this now runs unattended.**

1. **`hasDetail` was backwards for the most researched days.** `tripDaySchema`
   states that an ABSENT `detailStatus` means READY, and `planPipeline` writes
   the field only on days it did NOT detail — so a fully-researched generated
   day carried no status, and `hasDetail` read it as bare. Harmless while it
   gated a button; a silent deletion once the writer runs on its own.
2. **The skeleton wrote `distanceKm: 0`** on every drive leg, because
   `packStopsIntoDays` tracked minutes and dropped the distances that arrived
   on the same legs. A placeholder while a rebuild was deliberate, and a loss
   the moment it re-dates a generated day whose leg was measured at 180 km.
   `PackedDay` carries `driveKm` now, split proportionally when a long drive
   spans days — a constant-speed assumption over one leg, which is exactly
   what splitting that leg across days already assumes about the hours.
3. **`planMeta.totalKm` is no longer set to 0.** Same placeholder, same
   reasoning, except this one renders on the family's share link. The
   skeleton knows each day's distance now but not the trip's measured total,
   so it leaves that to whoever measured it.

And one crash found by a test rather than by a traveler: `planSkeletonWrite`
dereferenced `day.overnight.name` on every stored day. It used to run behind
the `has-detail` guard; it now runs against every day on every render, where
one malformed document would take the whole board down. Unmatchable rather
than throwing — and since an unmatched day reads as researched, the writer
stands aside and asks rather than deleting something nobody here understands.

**The header photograph became photographs.** A day built around a bike park
AND a lake is two things, and picking one to stand for the day throws away
what made it a full day. All the day's stops that carry a picture, the one
the day is built around leading so a glance still answers "where am I
sleeping" first, capped at four — past that each is about 90px on a phone and
recognisable as nothing.

Four e2e specs had to say which path they meant, now that a fixture day with
activities and no `detailStatus` correctly reads as researched: one asserts
the confirmation (its days really would be lost), three mark their days
`pending` to mean bare. A new one pins the headline: a locked stop reaches the
day strip on a generated trip **with nothing pressed**, and the researched day
that survives keeps its activities.

Verification: lint 0, build 0, frontend **446**, functions **664**, e2e
**166** — all green.

### 2026-08-31 — a scan result that has been read goes away

*"The information about the 7 added stops still shows up. It should disappear
after looking at any of the stops."*

The result had **no natural end, by construction**. It is written to the TRIP
— `planMeta.rescanLastRunAt` and friends — rather than held in component
state, and deliberately so: a scan runs for minutes and its answer has to
survive the phone that started it going to sleep. That was the fix for
failures arriving with nothing attached. The cost, unnoticed until now, is
that nothing in the trip document knows whether anyone has READ it, so the
sentence sat across the map hours later describing a scan already acted on.

The end is the reading, and there are exactly two ways to read it: open one
of the stops it found, or move the list into a bucket that holds them. Both
are deliberate acts on the results; scrolling past is not.

**The narrower half of that rule is the one worth stating.** A filter change
counts only when the new bucket actually shows new stops — `filterShowsNewStops`,
the same predicate the "they are under Not locked" notice uses. Switching
from "Locked in" to "Must see" hides the finds just as thoroughly, and
silencing the one message that says where they went would be the opposite of
reading it. An e2e pins that: the notice survives a move to "No day yet" and
goes on "Show them".

Kept per viewer in `localStorage` rather than on the trip. This is "I have
seen it", which is true of one person on one device — writing it to Firestore
would make one traveler's reading dismiss the message for everyone else in
the van. And `localStorage` rather than the `sessionStorage` the pacing
banner uses: that one earns one say per app launch, while a scan result that
has been read is read for good. The run's timestamp is stored rather than a
bare flag, so the NEXT scan is a new message rather than the same one again.

**A test-construction error worth recording**, because it looked exactly like
a wiring bug: the first version of the spec clicked the candidate card and
the card did not select. Playwright clicks an element's centre, and the
centre of that card is one of its action buttons — which call
`stopPropagation`, correctly, so that "Lock in" is not also "select". Clicked
near the corner instead. Nothing was wrong with the product; the assertion
was aimed at the wrong pixel.

Verification: lint 0, build 0, frontend **450**, functions **664**, e2e
**168** — all green.

### 2026-09-01 — the pin that could never be given a day

*"Seems to not respond to any rebuilds. And I think we decided to remove all
rebuilds?! I can't enter any days either!"* — with a green *"Day list rebuilt
— 4 days from your 6 kept stops"* sitting directly above an amber *"3 kept
stops are not in them"*.

**Both banners were telling the truth.** `planSkeleton` drops any stop whose
`country` is not exactly two letters, because `overnightStopSchema` requires
one and writing a malformed day would surface a long way from here. That
filter is right. What was wrong is that **`AddCorridorStopForm` never wrote a
country at all** — a hand-placed pin got a name, coordinates, and nothing
else.

So every stop the traveler pinned themselves was invisible to the day packer
for good. It could never be given a day; `stopsAddableToRoute` counted it
forever; the "these days are from an earlier plan" banner therefore never
cleared; the day strip stayed *derived* rather than reading real days, which
is why no day could be opened; and the button the banner offered could not
possibly help, because the stop was discarded before the packing began. One
missing field produced every symptom in that message.

Three changes, and the middle one is the one that matters tonight:

1. **The form writes a country.** `addressComponents` comes back on the same
   Places lookup the autocomplete already makes, so this costs no extra call.
2. **Stops already saved without one are repaired.** Nothing the traveler
   could press would fix those, so the board reverse-geocodes them — the Maps
   JS API is already loaded for the map — and writes the field back. Narrow
   on purpose: locked and not done (the only stops the day list packs), five
   per pass, one field, and only when the lookup actually succeeded. A
   failure leaves the stop untouched to be retried rather than stamped with a
   guess.
3. **The drop is no longer silent.** `planSkeleton` reports how many stops it
   could not date, and while any remain the banner says so instead of
   offering a rebuild — *"3 of them are still having their country looked
   up"*. A button that provably cannot do the thing it names is worse than no
   button, and this one had been there since hand-placed pins existed.

On *"I think we decided to remove all rebuilds"* — the automatic writer does
handle every case where nothing would be lost, and did here. What it could
not handle was stops it had never been allowed to see. The rebuild button
remains only for the one case a person has to approve: a researched day whose
place has left the route.

Verification: lint 0, build 0, frontend **456**, functions **664**, e2e
**170** — all green (`corridor.spec.ts:142` flaked once in a full run and
passes in isolation and on re-run).

### 2026-09-01 — a repair that was never attempted, and a chip that led nowhere

*"Still can't open days. When I click it seems to reload something, then goes
back to same."* — with *"3 of them are still having their country looked up"*
still on screen hours after it shipped.

**The lookup had not failed. It had never been attempted.** The effect that
repairs a missing country fired on mount and asked `google.maps` for the
geocoding library before the Maps script had loaded. That throws; the throw
is caught inside `reverseGeocodeCountry`; and `fillMissingCountries` then
*resolves*, having written nothing. The guard ref — which only cleared on a
rejected promise — stayed set, so the repair never ran again for the life of
the page. A silent success is a worse failure mode than an error, and this
one was invisible from both ends: no console error, and a banner truthfully
reporting a state nothing was working to leave.

Two fixes, and the first is the general lesson: **wait for the thing you
depend on to exist** rather than trying and hoping. `useMapsLibrary('geocoding')`
is exactly that signal, and it re-runs the effect when the library arrives.
Second, a pass that resolves with nothing written now clears the ref, so
"nothing resolved" is retried rather than treated as "nothing to do".

**And the day chips led nowhere.** The strip reads the board rather than the
stored days whenever ANY kept stop is missing one, and every chip on it
opened the rebuild — written when a derived strip meant no stop had a day at
all. Once some stops could be packed and others could not, that sent a
traveler whose day existed into a rebuild that changed nothing it could
change and returned them to the same screen: precisely "reload something,
then goes back to same". A chip now opens its stop's day where it has one,
and falls back to the rebuild only where it genuinely does not.

Verification: lint 0, build 0, frontend **456**, functions **664**, e2e
**171** — all green.

### 2026-09-01 — stop depending on the network for the field that decides everything

*"Clicking the first of today yields the same error. The second today gets me
into the day… Also, the banners. Why are they there?"*

**Two attempts at the same repair had both leaned on a network call**, and the
banner was still on screen an hour later. First the effect ran before
`google.maps` existed — caught, resolved having written nothing, ref stuck.
Then gating it on `useMapsLibrary('geocoding')` fixed that race and
introduced a worse one: a phone that never gets the geocoder never repairs
anything at all, and a phone at an Italian campsite is exactly that phone.

The mistake was the dependency, not the timing. **The stops around a pin
already answer the question.** A hand-dropped pin sits among the stops it was
dropped between, and on a road trip those are in the same country as it. So
the geocode is tried where it is available and `countryFromNeighbours` answers
where it is not — nearest stop with a known country, within 50 km, which is
close enough to be confident and far enough to span the gap between two stops
on one leg. A wrong flag on an overnight is a small cost; a stop that can
never be given a day is not.

**And the chips explain both banners.** The strip reads the board while any
kept stop lacks a day, and a chip with no day behind it opened the rebuild.
Tapping the first "Today" therefore fired a rebuild that could not place that
stop — it had no country — wrote a green *"Day list rebuilt"* on the way past,
and returned the traveler to the identical screen. That is the whole of "seems
to reload something, then goes back to same", and the whole of why two banners
were stacked at the top of the map. Such a chip is now inert and visibly so.
A control that cannot do the thing it appears to do is worse than one that is
plainly not ready.

Verification: lint 0, build 0, frontend **460**, functions **664**, e2e
**172** — all green.

### 2026-09-01 — a request that outlives the screen has to say so

*"Searched for dinner stops inside today. Closed app, expecting results when
I came back. Still nothing. No status."*

**There was nothing to come back to.** `detailDaySection` wrote its results at
the END — `filledSections`, the restaurant documents — and nothing at all
before that. So a fill in flight existed only as a promise held by one
component, and its failure only as a string in that component's state. Close
the app and both are destroyed: no results, and no account of why.

This is exactly the lesson `planMeta.rescanLastError` learned on 2026-08-16
— *"three rescan failures in a row were diagnosed by guesswork"* — applied to
the one path that never got it. The day now carries `sectionStatus` (which
section is running, and since when) and `sectionLastError` (which section
failed, why, and when), written before the expensive call and cleared by the
run that succeeds.

**And it matters most right now for a reason that is not a code bug**: the
commonest failure this week is the Anthropic account being out of credit, so
the dinner request failed within a second, said so to a screen that was then
closed, and left the traveler with silence. The message will now be waiting:
*"That failed: Your credit balance is too low…"* — a fact about the account,
not about the day, and one nobody could have guessed from an empty section.

Three details worth keeping:

- **A dinner that failed says nothing about lunch.** Both fields are keyed by
  section, so one section's trouble stays out of another's.
- **A run in flight outranks an older failure** for the same section, or a
  retry would report the previous attempt's error while working.
- **A container killed mid-run leaves `sectionStatus` behind with nobody to
  clear it**, so a fill older than five minutes reads as stalled rather than
  spinning forever. Generous on purpose: being wrong in the impatient
  direction costs a second paid call. The screen carries a ticking clock so
  that transition happens while the traveler is looking at it.

Verification: lint 0, build 0, frontend **467**, functions **664**, e2e
**173** — all green.

### 2026-09-01 — the third path finally saves its work too

*"Make sure both rescan on map and day plans are saved."*

Audited rather than assumed, and two of the three already were:

- **"Rescan this area"** writes its finds straight into `corridorStops`
  server-side, and reports itself through `planMeta.rescanLast*`.
- **A day-section fill** commits its places before the callable returns, and
  since this morning records `sectionStatus` / `sectionLastError` as well.

**The map's preset and free-text search was the odd one out.** It returned
its finds to the caller and wrote nothing at all, so locking the phone during
a ten-second Claude turn threw the answer away, and a search still running
had nothing to report on the way back. It now writes to
`trips/{tripId}/scratch/lastSearch`: the query, the status, the finds, which
engine answered, and why it failed when it did.

**Deliberately not to `corridorStops`.** The rule from 2026-08-23 stands —
*"the results are a scratch list for right now; nothing is saved unless you
tap Add"* — because it is a rule about the traveler's STOPS, not about
forgetting the answer to a question they just paid for. Adding a find removes
it from the scratch list, on every device.

**Two real bugs fell out of writing the test for it**, both invisible until
the finds outlived the tab:

1. **Search results rendered nowhere when the stop list was empty.** The
   whole sidebar body sat inside `candidates.length === 0 ? empty : list`,
   and the finds were in the `else`. So a fresh trip — exactly when someone
   searches — drew the "nothing here yet" paragraph and put the results
   nowhere. They were on the map and in the trip, and the one place a
   traveler would look was the one place they were not.
2. **A failed search read as a search that found nothing.** A failure now
   leaves a real document with an empty `finds`, which the panel happily
   summarised as "Nothing found in that circle" — the exact thing
   `querySearch` was corrected for on 2026-08-24, re-created from the other
   end. Only a `done` search is a result; a `failed` one reports its reason,
   which now also survives the app closing.

Verification: lint 0, build 0, frontend **467**, functions **664**, e2e
**174** — all green.

### 2026-09-01 — what the packer actually does, measured

*"I have 3 four hour activities that should go into today. 1 is dropped and
one is put at day 6, after many things that are a lot further away."*

Probed rather than reasoned about. Three four-hour stops a few minutes apart,
`maxDriveHoursPerDay` 5:

    day 1 — stops a, b · drive 25 min · stay 480 min
    day 2 — stop c    · drive 15 min · stay 240 min

So two facts, both verifiable:

- **The packer never drops a stop.** Every stop it is handed lands on a day.
  A kept stop with no day was therefore dropped BEFORE the packing — the only
  filter there is `usable`, which requires a two-letter country. That is the
  same fault as this morning's, and it is still the only way a stop can
  vanish.
- **The packer never pushes a stop to "day 6".** It fills days in the order
  it is given, so a spill lands on the NEXT day. A nearby stop appearing on
  day 6 is a statement about the route ORDER, which comes from Google's
  optimisation across the whole remaining trip — including the run home — and
  not from the day assignment at all.

And the third fact is the one nobody wants: `USABLE_HOURS_PER_DAY` is 10, so
**three four-hour activities do not fit in one day** by 2 hours. The split is
the app telling the truth about a plan, not losing anything.

The change made here is diagnostic, because every report about this has had
to begin with a guess: the out-of-step banner now NAMES the kept stops that
have no day rather than counting them. "1 is dropped" was unanswerable from
that screen; "Ciclopista del Garda is not in them" is not.

**Left open deliberately**, because the two readings lead to different work
and it is the traveler's call: whether the durations should give (three
four-hour sights in one day is 12 hours), or whether "what am I doing today"
should be driven by proximity to where the van is now rather than by a
whole-trip driving optimisation.

Verification: lint 0, build 0, frontend **467**, functions **664**, e2e
**174** — all green.

### 2026-09-01 — "behind you" needed a sense of scale

*"No need to raise ceiling, but you need to investigate why the stop is put
last with google optimization. I don't think it does such a poor job, rather
I think there is a bug with how the optimization is fed the list or similar."*

**Right on both counts.** Google was not the problem, and the list it was fed
already had the stop last.

The plumbing checked out: `askedBackbone` is built from `guessedOrder` and
never from Google's own answer, so `waypoint_order` — which indexes the
waypoints, i.e. the stops — is applied to exactly the list it describes. No
off-by-one, and rule 1 of routeOrder.ts is honoured.

The fault was one line upstream, in `orderStopsFromHere`:

    const ahead = measured.filter((entry) => entry.along >= 0)
    const behind = measured.filter((entry) => entry.along < 0)

**The sign test has no sense of scale.** Parked among a cluster of things to
do, half of them project a few hundred metres NEGATIVE against a line
pointing at the end of the trip — noise, not a statement about anything — and
each was exiled behind every stop ahead, however far away those were. Hence a
four-hour activity a few minutes from the van landing on day 6 behind things
hundreds of kilometres off. And on a day the van has not moved far enough to
re-key Google's stored answer, this guess IS the order the traveler sees.

So "behind" now has to mean *meaningfully* behind. Anything within 20 km of
the van is simply where you are — you will do it now whichever compass
direction it lies in — and sorts nearest-first at the front. Beyond that the
ahead/behind rule is untouched, which is what keeps the ORIGINAL report fixed:
Kronplatz, some 50 km the wrong way from the Seiser Alm, still sorts last.
Both cases are now tests, and the new one was confirmed to fail under the old
rule before being kept — three of six ordering tests once passed against the
code they were meant to indict, and that is not repeated here.

What this does NOT change: three four-hour activities are still 12 hours
against a 10-hour day, so two share today and the third moves to tomorrow.
The traveler declined to raise the ceiling, and the split was never the
complaint — the sixth day was.

Verification: lint 0, build 0, frontend **469**, functions **664**, e2e
**174** — all green (`dayview.spec.ts:140` and `responsive-offline.spec.ts:33`
flaked once in a full run; both pass in isolation and on the re-run).

### 2026-09-01 — retiring the frozen-plan relics

*"The edit route contains an old route, not the current… Also update the
share link for viewers so it's the dynamically updateable plan they are
seeing. Look through and find old relics in the code that still relies on the
previous 'freezing' of travel plans."*

**"Edit route" was a relic twice over.** It listed `status === 'committed'`
stops — what a full GENERATION writes, and nothing else — ordered by the day
indices of that generation. On a trip curated since, that is an old route by
construction, which is exactly how it was reported. And it submitted through
`reconcileCorridor`, the paid server pass that rewrites every day and every
date, for what the skeleton writer now does for free in a second.

Replaced, on the traveler's own instruction — *"I don't like the current
order arrows, as it doesn't show how it changes things. So retire the arrows,
but keep the list as the manual sorting of the order. It should have a button
to reset to full automatic google ordering."* — by `RouteOrderPanel`:

- the **locked** stops, in the order they will actually be driven;
- every row carries the day it would be reached, and those dates re-derive as
  the order changes. That is the answer to "it doesn't show how it changes
  things": the change is the dates;
- moving one writes a manual `routeOrder` (`manualRouteOrder`, which already
  existed from phase 5) — no callable, no plan request, no end-date tick, and
  the day list follows on its own;
- **"Back to automatic order"** appears only once there is something to undo.

The per-card **Order ↑↓ arrows are gone**, and so is **"Add to route"** — a
button offered on a locked stop with no day, which opened the reconcile panel
to slot it in. Nothing needs slotting in now; a locked stop is packed from
the board. It pointed at a panel that no longer adds anything.

**The share view was already live** — it polls, reads days and stops on every
request, caches nothing, and already includes locked stops. One relic in it:
`totalKm` and `avgDriveMinutesPerDay` came off `planMeta`, which only a full
generation ever writes. A board-built trip had never had them written; a trip
generated in July still reported July's total. Both are now measured from the
days being shown, whose legs carry real Google distances.

**Three e2e specs drove UI that no longer exists** — removal with the
end-date tick, add-then-reconcile, and add-to-route opening the panel. Their
behaviour is not lost: `corridorReconciliation.test.ts` covers it in 16
server-side tests, including day deletion, the accounted-day-count failure,
adding through the detail phase, and the country/proposed rejections. The
callables remain; only the entry point is gone.

#### Relics still standing, reported rather than changed

Asked for and deliberately not touched — *"Not yet — report first"*:

1. **Two statuses mean "on the route".** `locked` is what the board sets;
   `committed` is what `generatePlan` and `corridorReconciliation` write. They
   diverge by surface: `routeEditing.committedStopsInRouteOrder` filtered
   `committed` only (the bug above), `viewSharedTrip` accepts
   `committed || locked`, the board's own list accepts
   `candidate | locked | proposed`, and `routeStops` is locked-only. Every
   future "why is this stop missing" has a good chance of being this.
2. **`updateTripSettings` still marks a plan `stale`** for `startDate`,
   `endDate`, `startPoint`, `endPoint`. Not an oversight: `detectDateShift`
   is gated on `staleSettings` containing date keys only, so widening it
   would silently retire the "move the plan 7 days later" shortcut (recorded
   on 2026-08-25). The other six settings became advice in phase 2.
3. **`GENERATE_LABEL` / "Rebuild plan"** on Trip setup, and `generatePlan`'s
   full pass — still the only way to get researched detail across a whole
   trip at once. Not reachable by accident, and not destructive since
   generation honours curation, but it is the frozen-plan button.
4. **`replanTrip`, `insertRestDay`, `RequestChangesForDay`** — server passes
   that rewrite days wholesale, each behind its own busy gate. They work; they
   are the last places a trip is treated as an artefact to be regenerated.

Verification: lint 0, build 0, frontend **469**, functions **664**, e2e
**172** — all green.

### 2026-09-02 — the overnight choice was never saved, by design

*"I went in to add alternative overnight stops through change overnight stops.
It was not saved now that I went back to the same day. I want the stops
saved!!"*

It was not saved, and the code said so in its own comment:

> picking one doesn't patch `TripDay.overnight` directly — that would leave
> every following day's drive leg silently stale. Instead it submits a scoped
> replan.

So choosing a campsite wrote a `planRequests` document and waited for a Claude
pass to rewrite the remainder of the trip. **Nothing changed on the day until
that finished** — and with the API account out of credit it never finished,
so the choice evaporated in silence. Another relic of the plan-as-frozen-
artefact model, and the third this week where the old machinery turned a
one-field edit into a paid rewrite.

The fear behind it is obsolete. Following days no longer hold a frozen drive
leg that a change here would strand: the day list is re-derived from the
board, and the legs come from the live Directions call the map is already
making. So it is now one field, on one day, written immediately.

**`townAnchor` is the load-bearing half**, and this would have broken again
the moment the first half was fixed. `planSkeletonWrite` matches a stored day
to a rebuilt one by where it SLEEPS — so moving the overnight onto a campsite
15 km outside the town makes the day unrecognisable to the very function that
preserves it, and the next pass deletes it and writes a fresh one, taking the
choice with it. The town is the day's identity; the bed is a decision about
it. Recorded on the first change and never overwritten, so the anchor stays
the town however many campsites are tried. Both halves are tests, including
one asserting the day WOULD be lost without the anchor.

The picker also shed `trip`, `priorDayIds` and `onSubmitted` — props that
existed only for the replan — and its double-submit guard, which existed
because two replans against overlapping state corrupted a trip in August.
Writing one field twice is simply the second answer. It still watches
`planBusy`: a full generation owns the days while it runs and would overwrite
a choice made underneath it.

Verification: lint 0, build 0, frontend **471**, functions **664**, e2e
**173** — all green.

### 2026-09-02 — a day that did not know what came before it

*"There is also mentions of the origin being the trip origin for the first
night."* — under a card in the Dolomites reading **"Lüneburg, Tyskland →
Folgaride bike park · 42 km · 59 min"**.

The distance and the time were the real leg from the previous Italian stop.
The NAME was the trip's start point, a thousand kilometres north. Both came
from `toTripDay`, which was handed an index and a settings object and
**nothing at all about the day before it**:

    const previous = index === 0 ? settings.startPoint.name : undefined
    …
    drive: { fromName: previous ?? 'Previous stop', … }

So the first day named the start point however far away the route had since
moved, and every later day wrote the literal placeholder *"Previous stop"*.

The same blindness had a second consequence, and it is the other half of how
a night in Italy came to be labelled with a town in Germany: `lastStopBefore`
returned `allStops[0]` — the first stop of the whole trip — as the overnight
of any day that reached no stop. A pure driving day between two far-apart
stops therefore slept, on paper, wherever the trip had begun.

Days are built in sequence now, each one handed the night before it. A drive
leaves from last night's overnight; the first leaves from where the route
actually starts, which on the road is the van and not a start point left
behind weeks ago. A day that reaches no stop keeps last night's overnight,
because it has not moved the night anywhere. `lastStopBefore` is gone.

Verification: lint 0, build 0, frontend **474**, functions **664**, e2e
**173** — all green.

### 2026-09-02 — where to sleep becomes an ordinary section

*"I want the overnight stop options to show on the map in a similar way as
activities and restaurants."* — and then, shown a bespoke panel wired to the
map with its own open state and its own highlighting: *"I want the exact same
kind of logic as the list for the restaurants and activities. There is no
need for different functionality, or is there?"*

The push-back was right and the first attempt was mine inventing a mechanism
next to one that already existed. The overnight options are now a section of
the day — "Where to sleep" — built from the same `CardRow` and `PlaceCard`
every other row uses, because every part of the old panel already had a
counterpart:

| The panel had | The day already had |
|---|---|
| a link that opened a collapsible list | a row that is simply there |
| its own fetch on open | a "Find where to sleep" button on an empty row, exactly like "Find things to do" |
| its own highlighted-row styling | `selectedPlace`, shared by every card and pin |
| nothing on the map | pins that select their card, like an activity's |

The candidates are streamed by `useDayDetail` alongside activities and
restaurants, so they are on the map whether or not anyone opens anything, and
they survive the app closing like every other lookup — the callable writes
them to the day rather than returning them into component state.

**The one real difference, since it was asked directly:** an overnight is a
single choice that lands on the day, where an activity or a restaurant each
carries its own status and several can be selected at once. So a card here
reads as chosen rather than as selected-among-many, and choosing one
un-chooses the last. That is a fact about sleeping in one place at a time,
not a reason for different machinery.

Two things were kept from the panel because they are content rather than
structure: the wild-camping caveat (legality varies by country, and the app
is suggesting somewhere to park overnight), and the distinction between a
look that has not happened and one that came back empty — every source can
be unreachable at once, and "nothing found nearby" is then the honest answer
rather than an error. `OvernightCandidatesPicker` is deleted.

**Environment note**, recorded because it cost a confusing half hour: the
container was recycled mid-session and took `node_modules`, `functions/lib`
and the local `.env` with it. The symptoms were a TypeScript "cannot find
type definition file for google.maps", then every e2e failing at sign-in,
then two unit suites failing with `auth/invalid-api-key`. `npm ci` in both
roots, `npm run build` in `functions/`, and the emulator-mode `.env` that
`ci.yml` writes for itself.

Verification: lint 0, build 0, frontend **470**, functions **664**, e2e
**174** — all green (`execution-mode.spec.ts:76` flaked once in a full run
and passes in isolation and on the re-run).

#### 2026-09-03 — the row failed twice and said nothing (follow-up)

Reported with two screenshots the same day the row shipped: *"Seems like
there is some at least visual issues here. Looks like when I click the
button two texts are shown. Then I get these errors."*

Two defects, one of them mine and one older:

1. **The failure was rendered twice.** `CardRow` renders its `empty` slot
   *and* its `footer`, and the error had been put in both — so a failed look
   printed two identical red lines. The footer is now the single place a
   failure is reported; the empty slot holds only the fill button and the
   "Nothing found nearby" note.
2. **The failure said nothing.** `getOvernightCandidates` called
   `fetchOvernightCandidates` with no `try`/`catch`, so anything that was
   not already an `HttpsError` reached the browser as the bare word
   `internal` — the trap `rescanCorridorCallable.ts` has documented since
   2026-08-16. It now wraps the call and names the cause with
   `describeCause`, and the row prefers the server's own account over the
   generic line via `describeOvernightSearchError`, the third screen to use
   `callableError.ts` after the explore search and the country briefs. The
   commonest cause this week is the Claude account being out of credit,
   which no amount of pressing the button again will fix, so the row now
   says so instead of advising a retry.

On the overlapping button text: only one button exists — `CardRow` renders
`empty` **or** `children`, never both, and the `{busy ? 'Looking…' : 'Find
where to sleep'}` swap is the same one every other section uses. The
duplicated *error* was the real defect behind that screenshot.

#### 2026-09-03 — `locked` vs `committed`, and the button that outlived its panel

Asked on 2026-09-01 whether the two statuses should converge, the answer was
*"Not yet — report first"*. This is that report, plus the one place the
divergence was actively breaking a screen.

**What each status means now.** `committed` is written by exactly one thing:
a full generation, for its own overnight towns (`functions/src/corridorStops.ts`).
`locked` is written by everything a traveler does — pinning a stop, locking
a candidate, keeping a rescan find. The one other writer of `committed` was
"Add to route" through `corridorReconciliation`, and that button is gone
(2026-09-01): the day writer packs a locked stop from the board on its own,
so nothing a traveler presses can produce a `committed` stop any more.

**Where they diverge today:**

| Surface | Filters on | Right? |
|---|---|---|
| The day writer (`skeletonDays`) | `locked`, not done | yes — this is the plan |
| `routeStops` on the map | `locked`, not done | yes — same set |
| Explore list, "Locked in" filter | `locked` | yes |
| Shared trip view | `committed` **or** `locked` | yes — a guest should see both an old generation's route and a curated one |
| `dayCleanup` (which days are orphans) | `committed` **or** `locked` | yes — same reason: a day is not an orphan because the plan that made it is old |
| Generation's seed query | `candidate`, `locked`, `committed` (traveler-origin only) | yes, and deliberately: see the 2026-08-19 note in `generatePlan.ts` |
| **"Edit route" button** | `committed` stops with days, or `locked` stops **without** days | **no — fixed here** |

The button was the live bug. Its panel moved to the kept stops in driving
order on 2026-09-01 — the whole point of *"the edit route contains an old
route, not the current"* — but `canEditRoute` was left asking the
frozen-plan question. On a curated trip both halves of it go false: nothing
is `committed`, and the skeleton writer gives every kept stop a
`linkedDayIds` the moment it writes the days. So the button disappeared from
exactly the trips whose order is worth arranging by hand, while the panel
behind it had a full list. `canEditRoute(routeStops)` now asks the panel's
own question — is there more than one stop to order — and
`committedStopsInRouteOrder` is deleted with it.

**Recommendation on converging the two:** not worth a migration. `committed`
is now a historical marker — "a generation wrote this town" — read by two
surfaces that deliberately want both statuses, and by the generation seed
that deliberately treats them differently. Collapsing it into `locked` would
lose the distinction `generatePlan` depends on (its own overnight towns must
not seed the next plan; a traveler's stops must). Left alone, it decays on
its own: no new `committed` stops are being written.

Deleted with it: `ReorderCorridorPanel.tsx` and `src/lib/reconcileCorridor.ts`,
the last client path to the paid reconcile pass, unrendered since 2026-09-01.
The `reconcileCorridor` request kind stays on the server — nothing writes one
any more, but a queued request from before the change must still be readable.

Verification: lint 0, build 0, frontend **478**, e2e **174** — all green.

#### 2026-09-05 — one find for 150 km of Italy

Reported with a screenshot of a 150 km circle over Abruzzo: *"Searched 150 km
of Italy and it found one stop?! I want it to find the best of the region.
There must be A LOT more!!"* — and the on-screen line said the one place it
did suggest could not be found on the map, so the traveler got nothing at
all from a search that ran for minutes.

The count is not an accident of that particular run. **The prompt has never
told the model how many places to propose.** `MAX_RESCAN_RESULTS` has existed
since the feature shipped, but it is a server-side slice applied after the
answer comes back — the model was never told a cap existed, let alone what a
good answer looked like. What it *was* told about quantity was "Do not pad"
and "an empty finds list is a valid and honest answer": two arguments for
fewer, and nothing whatever on the other side. One find was the model doing
as it was asked.

So the ask is now explicit and scaled to the ground being covered, because
the honest number really does differ — a 150 km circle across a European
region holds a dozen good stops and a 5 km circle around a mountain hut holds
a handful:

| Search | Asked for |
|---|---|
| Corridor, or a circle ≥ 75 km | 12 (`MAX_RESCAN_RESULTS`, raised from 10) |
| A circle ≥ 25 km | 8 |
| Anything smaller | 5 |
| A typed query ("coffee stop") | 6 — a handful, and on a 1500-token budget |

The prompt now carries that number as `howManyToPropose`, says it is the size
of answer the area deserves rather than a ceiling to stay under, asks for the
finds spread across the whole circle rather than clustered on its centre or
its best-known town, and points out that proposing more costs the traveler
nothing: every name is verified against real map data and they review each
card. The counterweight survives as its own rule — fewer is still the honest
answer for ground that holds fewer, and an area with fewer *famous* places is
still not an area with fewer places.

**Second fix in the same call:** the already-on-the-list names are now sent
nearest-first. Only the first 60 reach the prompt and the order was whatever
Firestore happened to return, so a trip running the length of Italy could
spend the entire allowance on stops 800 km from the circle being searched —
and send none of the ones a search there could actually propose twice. The
comment on `MAX_EXISTING_STOPS` has claimed this ordering since the day it
was written; now the code does it.

### Known documentation gap

- [ ] **Work between 2026-08-03 and 2026-08-11 is in the code but not in this file** (noticed 2026-08-13 while bringing Sections 3–7 up to date) — the backlog above runs continuously to the access-gate entry of 2026-08-03 and then resumes at 2026-08-10. Sections 3, 4, 7 and 10 have been corrected where that work made them factually wrong, but these have no entry of their own explaining what was decided and why:
  - a Claude spend report run from the app's own Cloud Logging output (`.github/workflows/usage-report.yml`, `scripts/analyzeClaudeUsage.mjs`);
  - Places answering with the wrong place entirely — the name-match filter now described in Section 6.4, whose motivating failure was a Helsingør dinner stop resolving to a hotel in Greece;
  - "Add a rest day" and "Request changes" acknowledging a submitted plan change and refusing a second one — root cause of a three-day trip becoming eleven, and a case where nothing broke: the trip was corrupted by something working, repeatedly, in silence;
  - the per-source deadline in the overnight picker (a source that never answers, rather than one that throws);
  - detour *time* alongside detour distance, route totals, and per-stop Maps links on the explore screen — landed in the same commit as the locked-only route change, which Section 3/7.2 now describe.
  - Also unrecorded in Section 4: the access allowlist document and the read-only share-token collection, both from the 2026-08-02/03 gate and sharing work, which have backlog entries but never made it into the data model.

---

**END OF MASTER PLAN — keep this file in the repo root as `MASTER_PLAN.md` and update checkboxes with every commit.**
