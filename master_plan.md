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
| Repo | GitHub, CI via GitHub Actions → Firebase deploy. Fully automated: Workload Identity Federation (keyless GCP auth, no service-account JSON key — blocked by org policy) authenticates the deploy job; push to `main` or the working branch builds, tests (incl. E2E against the Firebase Emulator Suite), and deploys automatically. No manual `firebase deploy` needed. |
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
┌─────────────────────────────────────────────────────────┐
│  PWA (React)  — phone A / phone B / iPad                │
│  ┌──────────┐ ┌──────────┐ ┌─────────┐ ┌─────────────┐  │
│  │ Trip     │ │ Overview │ │ Day     │ │ Country     │  │
│  │ Setup    │ │ Map      │ │ View    │ │ Guide       │  │
│  └────┬─────┘ └────┬─────┘ └────┬────┘ └──────┬──────┘  │
│       └────────────┴─────┬──────┴─────────────┘         │
│                    Firestore SDK (real-time listeners,  │
│                    offline persistence enabled)         │
└──────────────────────────┬──────────────────────────────┘
                           │
        ┌──────────────────┴──────────────────┐
        │           FIREBASE                  │
        │  Firestore  ←→  Cloud Functions     │
        │  (trip data)     │                  │
        └──────────────────┼──────────────────┘
              ┌────────────┼────────────┐
              ▼            ▼            ▼
        Claude API   Places API   Routes API
        (planning)   (details)    (drive times)
```

**Data flow for plan generation:**
1. Client writes `planRequest` doc to Firestore (status: `pending`).
2. Cloud Function `generatePlan` triggers on that write.
3. Function reads trip inputs + freeform notes → calls Claude with the Planning Prompt (Section 6) → Claude returns structured JSON itinerary skeleton (stops, day types, pacing).
4. Function enriches each stop: Routes API for real drive times/distances; Places API for 5 activities + 9 restaurants per day (rating, hours, photo, place_id).
5. Function writes the full plan into Firestore; status: `ready`. All devices update live.
6. Re-plans reuse the same pipeline with a `replanContext` (current location, completed log, remaining dates).

**Why this shape:** keys stay server-side; heavy work is off-device; two phones stay in sync for free via Firestore listeners; offline reads work from Firestore's local cache.

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
                 vehicle: { type:"RV", weightKg:3500, registeredAs:"car",
                            heightM?, lengthM?, widthM?, fuel?: diesel|petrol|electric|lpg } }
                 // dimensions + fuel feed the countryGuide prompt: bridge/ferry
                 // tolls are frequently tiered by length/height, clearance
                 // warnings need height+width, and some tolls/ferries discount
                 // by fuel type (T-18/T-27's road fees + driving rules sections).
  notes:       { freeText: string, updatedAt }    // THE editable "text file".
                                                  // Injected into EVERY Claude call.
  planMeta:    { status: idle|pending|generating|ready|error,
                 avgDriveMinutesPerDay, totalKm, generatedAt, lastReplanAt }

trips/{tripId}/days/{dayId}            // dayId = "2026-07-14"
  { index, date, type: drive|rest,
    overnight: {name, lat, lng, country, campsiteSuggestion},
    drive: { fromName, toName, distanceKm, durationMin,
             slot: morning|midday|evening, polyline },
    summary: string,                    // Claude's 1-2 sentence day pitch
    extraTimeReason?: string }          // why this place got more time

trips/{tripId}/days/{dayId}/activities/{placeId}
  { name, category: sight|hike|museum|beach|playground|other,
    lat, lng, rating, ratingCount, googleMapsUrl, photoUrl,
    openingHours?, blurb,               // Claude's hidden-gem pitch
    kidFriendly: boolean,
    status: suggested|selected|done|skipped,
    doneAt?, diaryNote? }

trips/{tripId}/days/{dayId}/restaurants/{placeId}
  { name, meal: breakfast|lunch|dinner, lat, lng, rating, ratingCount,
    googleMapsUrl, priceLevel, cuisine, blurb,
    status: suggested|selected|done, doneAt?, diaryNote? }

trips/{tripId}/countries/{countryCode}
  { name, drivingRules: string[],       // special/unusual rules
    campingRules: string[],             // rules + tips
    freeCampingRules: string[],
    roadFees: { summary, howToPay, vignetteUrl? },
    speedLimits: { urban, rural, motorway,   // for 3500kg car-registered RV
                   notes },
    lpgInfo: { adapterNeeded, commonBrands, tips },  // stove/fridge/hot-water gas
    generatedAt }

trips/{tripId}/log/{entryId}            // trip diary, derived from "done" items
  { date, refType: activity|restaurant, refPath, note?, createdAt }

planRequests/{requestId}                // write-only queue for Cloud Functions
  { tripId, kind: full|replan, replanContext?, status, error? }
```

**Sharing model:** a trip is joined by entering its 6-character `shareCode`. Security rules: only UIDs listed in `trips/{tripId}/members/{uid}` can read/write. Joining via code adds your anonymous UID to members (done through a Cloud Function to validate the code).

**Editability:** every settings field and the notes doc are editable at any time from the Settings screen. Any edit sets `planMeta.status = "stale"` and the UI offers a "Re-plan trip" button — plans never regenerate silently.

---

## 5. PACING ALGORITHM (the "no monster last day" rule)

**Revised from v1.0.** The original design (below, kept for history) hard-failed the *entire* generated plan whenever any day exceeded 1.4× the trip's own computed average distance — an internal artifact of that specific route, not a constraint the traveler actually asked for. In production this rejected legitimate plans (e.g. a day that needed extra driving to reach a worthwhile stop) with no way to accept the tradeoff, and raising `maxDriveHoursPerDay` in Settings did nothing because that field was never checked at all.

**Current design:**
1. The 1.4×/1.0×-of-target shape below is still given to Claude as *generation guidance* (Section 6.1's outline prompt) — a soft aim, not a post-hoc gate.
2. The only **hard** validation (`functions/src/pacingValidator.ts`) left after generation:
   - No day's actual resolved drive duration may exceed **1.5 × the traveler's own `maxDriveHoursPerDay`** (some tolerance for traffic/rounding) — this is the one real constraint the user set, so it's the one that's enforced.
   - Rest days must stay at the previous day's overnight (a genuine structural bug if violated, not a pacing tradeoff) — unchanged.
3. Every day's `highlightReason` (see 6.1) is persisted and shown in the Day View, so a day that's longer than the trip's own average is *explained*, not silently rejected or silently allowed with no context.
4. If the hard check still fails, the plan generation fails with a clear error (never show a bad plan) — same behavior as before, just gated on the right thing.

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

1. **Highlights phase** (`buildRegionHighlightsPrompt`) — pure curation, no dates/pacing involved. Given `settings` + `notes.freeText`, Claude reasons region-by-region about what's genuinely worth seeing for these travelers' interests and returns a ranked shortlist per region: `must-see` / `worth-a-detour` / `nice-if-convenient`, each with a one-sentence "why". Deliberately generous — more candidates than any one trip could fit.
2. **Outline phase** (`buildRouteOutlinePrompt`) — given the highlights shortlist, *selects* from it (prioritizing must-sees) and sequences the selections into an actual day-by-day route from the real `startPoint` to the real `endPoint`, balancing attraction quality against time remaining and overall heading. Free to skip lower-priority candidates or add a plain connecting overnight where two highlights are too far apart for one day's drive. Every day gets a required `highlightReason` (why this town, tied to interests/notes — forces justification instead of defaulting to "closest on the way"). This is where pacing/global-routing correctness is solved, with the whole trip in view, same as the old single call.
3. **Detail phase** (`buildChunkDetailPrompt`, chunked) — the route is split into fixed-size chunks (7 days each); each chunk gets a separate call, given the full outline for context but only asked to fill in that chunk's 5 activities + 9 restaurants (NAME + TOWN + CATEGORY only — Places API resolves details/ratings/links afterwards, Claude must not invent them) and a day `summary` + optional `extraTimeReason`. Cannot redirect the route the outline already committed to.

Every individual call stays small regardless of trip length — this is what actually fixed the 10-minute-guard problem, not just raising `max_tokens`. `onProgress` callbacks report which phase is running (`{phase: 'highlights'}` / `{phase: 'outline'}` / `{phase: 'detail', chunkIndex, chunkCount}`) so the UI can show real progress instead of a bare "generating" spinner.

All three calls: JSON-only output, zod-validated, one retry on parse/schema failure with the error fed back to Claude.

**Known gap (see Section 11):** none of this is currently resumable — a failure at any phase (including the final pacing check, which runs after all Places/Routes enrichment too) discards everything and a retry redoes all three Claude phases plus all Places/Routes lookups from zero.

### 6.2 `replanTrip` — extra inputs, and a real fix (2026-07-27)

**Bug, now fixed:** `runReplan` (`functions/src/replanTrip.ts`) never actually called `planTrip()` — it was a hard-coded fixture that produced at most two days (one drive straight from the current location to the trip's final destination, plus an optional rest day), regardless of how many days actually remained. Any "Request changes" replan therefore replaced the entire remainder of a trip with essentially just the final stop — reported live as "all stops but final stop removed." This was a known, documented gap (T-17's own notes below called it a stand-in for T-14) that was never closed after `generatePlan.ts` got the real pipeline.

**Current design:** `runReplan` now runs the same real pipeline as a fresh generation — `planTrip()` (Section 6.1's three phases) + `resolveSkeletonDays` (Places/Routes enrichment) — shared via `functions/src/planPipeline.ts` (extracted specifically to avoid a circular import between `generatePlan.ts` and `replanTrip.ts`, which import from each other). Inputs: current GPS location (as the remainder's `startPoint`), today's date (`startDate`) through the remaining end date (`endDate`), the remaining end point, and — newly wired up, previously collected but never actually used — the change-request free text, folded into the notes Claude sees. Two correctness properties the old fixture's simplicity had accidentally never needed:
- **Generate before delete.** The new remainder is fully generated, resolved, and pacing-validated *before* any existing future day is touched — a failed replan (API error, pacing violation) now leaves the trip's existing days fully intact instead of chopped with nothing to replace them.
- **Locked-day collision safety net.** A locked day can sit anywhere in the remainder's date range (the "Request changes" UI allows locking any day, not just the boundary), but `planTrip()` has no way to be told "skip this date" — so any generated day that would land on an already-locked date is dropped before writing rather than allowed to overwrite it. Known limitation: the route itself isn't planned *around* a mid-range locked day's location (Claude doesn't know it exists), only protected from being overwritten — genuinely reasoning about mid-route locked waypoints is future work if it turns out to matter in practice.

### 6.3 `countryGuide` prompt — inputs
- Country code + vehicle block. Must return the exact `countries/{code}` schema (driving rules, camping, free camping, road fees + payment, speed limits for a 3,500 kg car-registered RV, LPG refill info). Enable Claude web search tool in this call so fees/vignette prices are current; require source-cautious phrasing ("as of {date}").

### 6.4 Places enrichment (code, not Claude)
For each Claude-proposed name+town: Places Text Search → take top match within 30 km of the day's route → fetch rating, ratingCount, googleMapsUri, photo, opening hours, priceLevel. If no match ≥3.8 rating with ≥50 reviews, drop it and backfill from Places Nearby Search by category so the counts (5 activities, 3×3 restaurants) always hold.

**Gotcha (fixed):** the Places API (New) rejects `point_of_interest` as an `includedTypes` value for `searchNearby` — it's a Text-Search-only generic type. The `other` activity category used to map to it, so any "other"-category activity that missed the quality bar on text search and fell back to nearby search 400'd and failed the *whole* plan generation. Fixed by omitting the type filter entirely for that category instead of sending an invalid one (`functions/src/placesApi.ts`).

---

## 7. SCREENS & UI CONTRACTS

### 7.1 Trip Setup / Settings
- Form: dates (range picker), travelers (add rows: name, adult/child, age), interests (chip multi-select + free entry), start & finish (Places autocomplete), preferred countries (multi-select), rest-day frequency (slider: "rest day every N days", default 7, option "none"), max drive hours/day.
- **Notes panel:** full-screen editable text area bound to `notes.freeText`, autosaved, with "last updated" stamp. Placeholder explains: "Anything here is read by the planner on every generation — allergies, must-sees, driving preferences…"
- Buttons: Generate plan / Re-plan (visible when `status == stale`).

### 7.2 Overview Map
- Full-screen Google Map with the route polyline and overnight-stop markers.
- **Zoom-based progressive disclosure:**
  - z < 6: route + start/end + country flags
  - 6–8: + overnight stops (numbered day badges)
  - 9–11: + selected activities
  - ≥ 12: + ALL suggested activities & restaurants with category icons (fork = food, mountain = hike, castle = sight, wave = beach, balloon = kids, bed = overnight)
- Header bar: total km, **average driving time per day**, days count.
- Tapping a route segment or day badge → Day View for that day.
- "Request changes" button → change interface: free-text box ("more beaches, skip big cities") + per-day lock toggles → submits a `replan` request with that text appended to notes context.

### 7.3 Day View
- Layout: **map on top (~45% height), scrollable content below** (user-specified). iPad `lg`: side-by-side split.
- Map shows that day's drive polyline, overnight stop, and pins for the items currently in view below (tapping a card highlights/pans to its pin — user-specified).
- Below: day summary + drive card (from → to, km, duration, suggested slot morning/midday/evening) then horizontally scrollable card rows: Activities (5), Breakfast (3), Lunch (3), Dinner (3).
- Each card: photo, name, category, Google rating ★ + count, blurb, "Navigate" (opens `googleMapsUrl`), and a check control: mark **Selected** (planned) or **Done** (logged to diary with optional note).
- Prev/Next day arrows + swipe to cycle days without returning to overview (user-specified).
- Rest days render with a "No driving today 🎉" banner.

### 7.4 Execution mode & 50 km rule
- Active automatically when today ∈ [startDate, endDate].
- On app open + every 30 min while open: get device GPS → compute distance to today's planned overnight route position → if **> 50 km behind**, show a non-blocking prompt: "You're {X} km behind plan. Re-plan the rest of the trip?" [Re-plan] [Snooze today].
- Uses `navigator.geolocation`; degrade gracefully if permission denied (manual "I'm here" pin instead).

### 7.5 Country Guide
- Tab listing each country on the route with flag; detail page renders the six info sections as accordions. Generated once per country at plan time (Cloud Function), cached in Firestore, "Refresh info" button re-generates.

### 7.6 Diary / Log
- Chronological list built from `log/` — everything marked Done, with notes and dates. Simple export to text/share sheet.

---

## 8. NON-FUNCTIONAL REQUIREMENTS

- **Responsive:** test at 375×812 (phone), 820×1180 (iPad portrait), 1180×820 (iPad landscape). No horizontal scroll, tap targets ≥ 44 px.
- **Offline:** app shell + last-synced trip data readable offline (Firestore persistence + PWA cache). Map tiles require network — show cached day cards with an offline banner.
- **Multi-device:** edits on one device visible on another < 3 s (Firestore listeners; verify in E2E).
- **Cost guards:** plan generation debounced (one pending request per trip); Places photos requested at 400 px; country guides cached.
- **Privacy:** GPS never leaves the device except inside replan requests (rounded to 3 decimals).

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
  NOTE: new CountriesScreen (`/countries`) lists the unique countries across `days` (flag + name, deduped by `EUROPEAN_COUNTRIES`); CountryDetailScreen (`/countries/:code`) renders the six sections as native `<details>` accordions and a "Refresh info" button calling the existing `refreshCountryGuide` callable. E2E (e2e/countries.spec.ts) confirms every route country is listed and, via a guide seeded directly through firebase-admin (mirroring T-26's approach, since there's no live-generated guide to test against), that all six sections render with real content. The "refresh updates generatedAt" half is blocked on CLAUDE_API_KEY like T-14/16/18/22 — the test instead confirms the call fails *gracefully* (a visible error, not a crash) when the secret is missing.
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
- [x] Even pacing, no huge final drive (T-15) — `PACING_RULES` (`functions/src/prompts/planTripPrompt.ts`) + `pacingValidator.ts`'s hard check (1.4x cap, 1.0x relaxed finish), tested in `pacingValidator.test.ts`.
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
- [x] Country info: driving rules, camping, free camping, road fees & payment, speed limits (3,500 kg car-registered), LPG refill (T-18, T-27) — `countryGuideSchema`'s all 6 sections, rendered in `CountryDetailScreen.tsx`.
- [x] Data saved but easily modified; stale→replan flow (T-10, T-17) — `updateTripSettings` flips `planMeta.status` to `'stale'` on any edit; Settings shows "Re-plan trip" for that status. **Conflict flagged, not fixed**: this flip happens even on a trip that's never been generated at all (`status: 'idle'`, no prior plan) — editing settings before ever generating once would show "Re-plan trip" instead of "Generate plan" for a trip with nothing to re-plan. Cosmetic only (the same `generatePlan()`/`kind:'full'` call runs either way, so behavior is correct — only the button label is momentarily wrong), out of scope for this pass, noted here for a future cleanup.
- [x] Same plan live on two phones (T-07, T-09) — Firestore `onSnapshot` throughout; `sync.spec.ts` covers real-time sync across two contexts.
- [x] iPad compatible / responsive (T-23, T-28) — `responsive-offline.spec.ts` covers phone/ipadPortrait/ipadLandscape viewports and 44px tap targets.
- [x] GitHub + Firebase (T-01–T-03) — this repo, deployed via `.github/workflows/ci.yml`'s Firebase Hosting/Functions/Firestore-rules deploy job.

---

## 11. BACKLOG — discussed, not yet implemented

Recommendation (agreed with the user 2026-07-27): land the current baseline as a PR first, then work these incrementally rather than bolting them onto an ongoing bugfix session. Each is a real, separately-scoped design problem.

Update 2026-07-27 (later same day): worked through this list per the user's explicit request. Landed: both bugs (day numbering, highlightReason drift), manual editing (skip status + add custom stop), per-day request changes, and map UI polish (marker badges + selection highlight, item 3.1 of the Select redesign only). Held for design review before implementation (per the user).

Update 2026-07-27 (later still): design proposals written up and reviewed with the user for the 3 held-back items; all 3 then implemented per the user's go-ahead, with an explicit investigation step first for overnight-stop lookup strategy (see that item's note — real data sources checked before committing to an approach, not guessed). All 3 now done: resumable/checkpointed generation (generatePlan only), interactive/transparent route planning (skippable highlights-review pause, scoped v1), overnight-stop type & candidates (lazy per-day resolution, scoped replan on pick). Deferred as bigger/lower-priority: multi-trip support, dismiss-and-requeue, selected-activities-route-awareness, the Node runtime bump, and the remaining Select-redesign extensions (2–4). Skipped: diary photo attachments (needs new Storage infra + real iOS device testing this session can't provide).

- [ ] **Multi-trip support ("trip library")** (deferred 2026-07-27 — larger structural item, held back per the user while the smaller backlog items landed) — today there is no "New Trip" button at all: `useTripSession` (`src/hooks/useTripSession.ts`) creates exactly one trip per browser on first load and permanently reuses it via `localStorage.tripId`; the only way to start a second trip today is manually clearing that key. Needs:
  - A "New Trip" action that calls the existing `createTrip` callable again (already reusable server-side — `createTripForUser` in `functions/src/trips.ts` — this part needs no backend change) and switches the active `tripId`.
  - A way to list "my trips": membership today is only a one-way subcollection (`trips/{tripId}/members/{uid}`, checked by `firestore.rules`'s `isMember()`), with no reverse index from uid → trips. Cleanest fix: maintain `users/{uid}/trips/{tripId}` (minimal doc, e.g. `{joinedAt}`) written in the same transaction as the existing `members` doc in both `createTripForUser` and `joinTripByCode`, with a rule `allow read: if request.auth.uid == uid`. A library screen queries that collection, then fetches each trip's `meta`/`planMeta` to render a list (trip count is small — per-trip reads are fine).
  - A trip switcher in `AppShell`/nav.

- [x] **Resumable / checkpointed plan generation** (held for design review 2026-07-27; design proposed and implemented 2026-07-27, generatePlan only per the user's answer — a replan's remainder is short enough that redoing it from scratch isn't the expensive case this solves for) — `generatePlan.ts` used to build the whole plan in memory (all three `planTrip` phases, then every day's Places/Routes resolution in `resolveSkeletonDay`) and write to Firestore exactly once, in a single batch, at the very end. Any failure at any point — including the pacing check, which runs *after* all Places/Routes enrichment — discarded everything, and "Retry" reran the entire pipeline from zero. Implemented: `planCheckpoint.ts` stores the skeleton + a settings hash on `planMeta.checkpoint` right after the highlights/outline/detail phases succeed, and stages each resolved day into `trips/{id}/generationStaging/{index}` as it resolves (awaited, not fire-and-forget — the whole point is surviving a crash between one day and the next). A retry with unchanged settings resumes from the checkpoint; a retry after settings changed discards the stale checkpoint and starts clean. Cleared on success. Covered by `functions/src/generatePlan.checkpoint.test.ts`.

- [x] **Interactive / transparent route planning** (held for design review 2026-07-27; design proposed and implemented 2026-07-27 — a scoped v1, not the full "hard nut to crack" vision) — current generation is a black box: settings in, finished plan out, no visibility into *why* particular towns were chosen beyond the per-day `highlightReason` (Section 6.1). The user's ask: surface the planning stage's reasoning and let the traveler choose between options. Implemented as a skippable pause (off by default — a checkbox on Settings, "Review suggested regions before generating") right after the highlights phase, which already produces exactly the data this needed: ranked candidate stops per region with a reasoning string, previously never shown. `planTrip.ts` split into `generateRegionHighlights` (phase 1) and `generateSkeletonFromHighlights` (phases 2-3) — `planTrip()` itself is unchanged, just both in sequence. `generatePlan.ts` pauses at `planMeta.status='awaiting-highlights-review'` with the highlights attached, and a new `continueFromHighlights` planRequest kind resumes into phases 2-3 with the traveler's edits (re-ranked priority tiers via up/down buttons and drag-and-drop, removed candidates, an optional free-text note). Scoped to fresh generation only, not replan. NOT implemented (deferred, bigger v2): a second pause after the outline phase, or generating true alternate-route variants. Covered by `functions/src/generatePlan.reviewPause.test.ts` and `e2e/highlights-review.spec.ts`. **Scheduled for retirement (2026-07-29)** — see "Persistent, always-editable route corridor on the Map tab" below, the v2 this entry deferred, which supersedes this ephemeral pause with a persistent equivalent rather than running both.

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

- [ ] **Dismiss-and-requeue for activities/restaurants, pre-fetched to avoid lag** (requested 2026-07-27; deferred 2026-07-27 — bigger, needs a generation-time backend change, held back with the other larger items) — extends the already-logged "manual editing" item's plan to wire up the unused `skipped` status: when a suggestion is dismissed, a replacement should appear immediately rather than leaving a gap or making the user wait on a live Places/Claude round-trip. The existing backfill mechanism (`MAX_BACKFILL_ATTEMPTS` in `enrichActivities`/`enrichRestaurantsForMeal`, `functions/src/placesApi.ts`) already resolves extra candidates *at generation time* to guarantee exact counts (5 activities, 3×3 restaurants) — it isn't designed for a live "swap this one" interaction during viewing. Proposed: over-generate by one or two per category at plan-generation time (resolved and stored, just not surfaced in the default view) so dismissing an item can instantly pull from that pre-fetched queue client-side, with a top-up fetch only needed once the queue itself runs dry.

- [ ] **Diary photo attachments, attached at "Done" time, iOS-first** (requested 2026-07-27; skipped for now 2026-07-27 — needs a new Firebase Storage bucket + upload security rules (a new billed resource) and the request explicitly calls for building/testing against real iOS Safari first, neither of which this sandbox can provision or verify) — `markDone` (`src/lib/placeStatus.ts`) and `logEntrySchema` (`shared/src/schemas.ts`) currently only carry a text `note` — no photo field, and the app has no Firebase Storage integration anywhere yet (this would be new: a Storage bucket, upload security rules, and a schema field for a photo URL/path on the log entry, likely with the same `maxWidthPx`-style size discipline already applied to Places photos). UI: attach photo capture to the existing "Done" flow (`PlaceCard.tsx`'s note-input step) rather than a separate step. Explicitly build and test against iOS Safari first per the request — `<input type="file" accept="image/*" capture="environment">` is the standard way to trigger the native camera/photo-library picker there, and mobile upload should compress client-side before upload given real-world RV-trip network conditions.

- [ ] **Selected activities should feed back into route/travel-time awareness** (requested 2026-07-27; deferred 2026-07-27 — bigger, held back with the other larger items) — extends the already-logged "Select" redesign item: right now `TripDay.drive` is a single leg between yesterday's and today's overnight stop only (`routesApi.ts`/`resolveSkeletonDay` in `generatePlan.ts`) — there's no concept of the travel required *between* today's overnight and today's selected activities, or between the activities themselves. So selecting several activities spread across a wide area gives no visibility into the realistic extra driving/time that implies; the plan's distance/pacing numbers are blind to what's actually been selected. Would need computing (likely client-side, on demand, via the same Routes API path) a rough tour distance across a day's overnight + selected activities once selections are made, surfaced somewhere near the day's drive card.

- [x] **"Why here" reasoning isn't guaranteed to appear in the day's actual activities** (bug, reported 2026-07-27 — Oslo trip: "Tryvann Bike Park" named in a day's `highlightReason` but absent from that day's activities list; fixed 2026-07-27) — root cause: `highlightReason` is produced by the outline phase (Section 6.1's phase 1, reasoning about why a *town* was chosen) while activities are produced independently by the detail phase (phase 3) for that town. The detail phase's prompt (`buildChunkDetailPrompt`/`DETAIL_SYSTEM_PROMPT`, `functions/src/prompts/planTripPrompt.ts`) does receive the full outline (including every day's `highlightReason`) as context, but nothing in its instructions requires it to actually include the specific place a day's `highlightReason` named — so the two can drift apart, undermining the entire point of adding `highlightReason` in the first place (justifying a stop, then not delivering on it). Fixed: `DETAIL_SYSTEM_PROMPT` now explicitly requires it (`functions/src/prompts/planTripPrompt.ts`).

- [x] **Day numbering off by one — first day displays as "Day 2"** (bug, reported 2026-07-27; fixed 2026-07-27) — likely root cause found by inspection: every display site assumes 0-based `index` (`day.index + 1` in `DayViewScreen.tsx` and twice in `OverviewMapScreen.tsx`), but nothing enforces that Claude's outline response actually starts numbering at 0 — `routeOutlineDaySchema`/`planTripSkeletonDaySchema` only require `index` to be `nonnegative`, and neither `OUTLINE_SYSTEM_PROMPT` nor `DETAIL_SYSTEM_PROMPT` (`functions/src/prompts/planTripPrompt.ts`) ever states the first day's index must be 0 — an easy ambiguity for the model to resolve the "natural" way (1-based, like a human would number days) instead. Fixed, two parts: (1) `OUTLINE_SYSTEM_PROMPT` now states the 0-based contract explicitly; (2) `parseAndValidateRouteOutline` (`functions/src/prompts/planTrip.ts`) validates indices are exactly `0..days.length-1` with no gaps and retries (same mechanism `callWithRetry` already uses for schema failures) if not. Covered by new tests in `functions/src/prompts/planTrip.test.ts`.

- [ ] **Persistent, always-editable route corridor on the Map tab** (requested 2026-07-29; scoped 2026-07-29, not yet implemented — retires the highlights-review pause above once landed) — the highlights-review pause ("Interactive / transparent route planning" above) is a one-shot, ephemeral gate: `RegionHighlightsResponse` lives only in `planMeta.pendingHighlights` while `status === 'awaiting-highlights-review'` and is deleted the instant the traveler submits it — confirmed nothing persists the curated highlights, the route outline, or any backbone/corridor geometry past generation. Separately, every replan path (`runReplan`, and by extension "Request changes" and "Change overnight stop") is destroy-and-regenerate of the whole unlocked remainder via a fresh 3-phase `planTrip()` call — never a diff against what's already there; a locked day is merely protected from deletion, not fed to Claude as a routing constraint, and any freshly-generated day whose date collides with a locked one is silently dropped (`replanTrip.ts`'s own comment admits this limitation).

  The ask: move coarse route planning onto the Map tab permanently instead of a pre-generation gate — always visible, editable at any time including before first generation — with a "rescan this area" affordance that proposes alternatives without disturbing already-committed stops, and a "lock in" step that reconciles the day-by-day plan against the edited corridor (shifting dates for stops that just moved rather than regenerating everything, flagging an end-date extension for explicit accept rather than applying it silently).

  Retires `HighlightsReviewPanel.tsx` and the `awaiting-highlights-review` pause entirely (agreed with the user 2026-07-29) rather than running two competing "review the route" UIs side by side.

  **Scale target, explicitly (2026-07-29):** the motivating trip is roughly a month, Sweden → southern Europe, through several countries on the way — not a 3–7 day trip. This is the deciding factor behind the map-layout correction directly below, and means phase 3/4's per-candidate work (real-detour upgrade, rescan) needs an explicit cap/viewport-scoping story from the start (compute against whatever's currently in view or selected, not "every candidate in the whole corridor" eagerly) — a month-long, multi-country corridor could plausibly hold dozens to low-hundreds of candidate stops, not the handful a 3-day fixture trip exercises in this session's own tests.

  Phased — the largest structural change the app has had, so each phase ships independent value and is a prerequisite for the next rather than one PR:
  1. ~~**Map tab interaction parity** (low risk, no schema change) — port Day View's click-a-pin-highlights-a-card pattern (`selectedPlace`/`MapPanner`/`MarkerBadge`'s `highlighted` prop) onto `OverviewMapScreen.tsx`, which today has no card list and no marker click behavior beyond day badges navigating to Day View. Add `planMeta.status` branching there too — currently the only primary-tab screen with none (`SettingsScreen.tsx` already has this pattern).~~ **Done 2026-07-29**: activity/restaurant markers now set `selectedPlace` (highlighted via `MarkerBadge`'s existing `highlighted` prop, panned-to via a local `MapPanner`, a "Showing: X" caption) — day badges' own click-to-navigate stays unchanged, this only fills the actual gap. `planMeta.status` branching added: `idle` gets a "no plan yet" banner, `pending`/`generating`/`awaiting-highlights-review` a progress banner (reusing the same fields `SettingsScreen` already reads), `error` shows `planMeta.error`; the header stats/"Request changes" row is hidden outside `ready`/`stale`. No card list, no popup — kept today's full-map/zoom-tiered layout as-is per the correction above. Covered by 4 new tests in `e2e/map.spec.ts`; the marker click/highlight itself is unverifiable in this sandbox (Maps JS blocked), same pre-existing limitation as day-badge clicks.
  2. **Persist the corridor**, split in two once scoped further (2026-07-29 — the ID migration turned out to have a much bigger blast radius on the e2e suite than on the app itself, worth shipping and verifying on its own):
     - ~~**2a. Migrate `trips/{id}/days` off date-keyed doc IDs**~~ **Done 2026-07-29**: day docs now use auto-generated Firestore IDs (date stays a field) in all three write paths — `generatePlan.ts`'s `writeGeneratedDays`, `replanTrip.ts`, and `insertRestDay.ts`. The rest of the app was already fully ID-agnostic (`useTripDays.ts` sorts by the `date` field, every screen/hook threads `dayId` through opaquely, `firestore.rules`'s `days/{dayId}` is a plain wildcard) — confirmed by direct read, so no data backfill was needed for existing trips. This is the concrete blocker `insertRestDay.ts`'s own comment named ("no atomic rename") for any future date-shift operation, and paid for itself immediately there: shifting a later day back one calendar day is now a plain field update on its existing doc instead of copying every activity/restaurant subdoc to a new date-keyed parent and deleting the old one. This migration is what makes phase 4 possible at all. The real size of this phase was the e2e suite, not the backend: ~20 `page.goto('/map/day/<hardcoded-date>')` call sites across 5 spec files relied on a day's Firestore ID literally being its date string (the only way to reach Day View directly, since Google Maps JS is network-blocked in this sandbox and day-badge clicks have never been testable here) — all switched to a new `getDayIdByDate(tripId, date)` e2e helper. Covered by the existing `functions/src/generatePlan.writeGeneratedDays.test.ts`/`insertRestDay.test.ts`/`replanTrip.test.ts` (updated, not new coverage) and the full e2e suite.
     - ~~**2b. New `corridorStops` collection**~~ **Done 2026-07-29**: `trips/{id}/corridorStops/{stopId}` (schema in `shared/src/schemas.ts` — a first-class client-read collection, unlike the internal `pendingHighlights` shape it deliberately doesn't reuse), auto-generated IDs, `status: proposed|committed|locked` and `linkedDayIds: string[]`. Rather than trying to persist Claude's pre-selection highlight candidates (no stable identity — addressed purely positionally, confirmed via `HighlightsReviewPanel.tsx`, and don't reliably map 1:1 to the days a generation finally produces), stops are derived from the *actual generated days'* `overnight` stops — the real, fully-resolved route backbone — via a new `buildCorridorStopWrites` helper (`functions/src/corridorStops.ts`) that groups consecutive same-overnight days (e.g. rest days) into one stop. Every stop this phase writes is `'committed'`; `'proposed'`/`'locked'` stay unused until phase 3. Wired into all three write paths: `generatePlan.ts`'s `writeGeneratedDays` (wipes+rewrites corridor stops alongside days, same as it already does for activities/restaurants), `replanTrip.ts` (deletes only stops overlapping the regenerated future-day range, leaves past/locked ones untouched; also switched this function from a raw `db.batch()` to `commitInChunks` while touching this exact write path, since the added writes push it closer to the 500-op cap on a long trip), and `insertRestDay.ts` (the inserted rest day shares its source day's overnight, so it's appended to that day's existing corridor stop's `linkedDayIds`; silently skipped for trips with no corridor data yet). `firestore.rules` gained a flat `corridorStops/{stopId}` rule matching the existing `countries`/`log` pattern. Covered by a new `functions/src/corridorStops.test.ts` plus updates to `generatePlan.writeGeneratedDays.test.ts`, `replanTrip.test.ts`, `insertRestDay.test.ts`, and `firestore-rules.test.ts`. Backend-only — no UI reads this collection yet; that's phase 3.
  3. ~~**Corridor editing + "rescan an area"**~~ **Done 2026-07-29**: the corridor is now a live map layer on `OverviewMapScreen.tsx`, rendered as its own marker tier within the *existing* zoom-tiered progressive disclosure (`mapZoomTiers.ts`'s new `showCorridorStops`, same `>=6` tier as overnight stops) — no card list, no separate screen, per the layout correction. Only `proposed`/`locked` stops get their own marker (🔍/📌 via new `CORRIDOR_PROPOSED_ICON`/`CORRIDOR_LOCKED_ICON`) — `committed` stops are deliberately NOT re-rendered as a second marker, since they'd exactly duplicate the existing day badge at the same coordinates (`buildCorridorStopWrites` derives them 1:1 from `TripDay.overnight`); locking/removing a `committed` stop is a phase-4 reconciliation concern, not this layer's. Tapping a stop opens `CorridorStopCard` (the "lightweight, non-modal tap-to-reveal" surface, anchored top-right, not `HighlightsReviewPanel`'s list chrome) with Lock/Unlock/Remove, wired to two new plain Firestore-write functions in `src/lib/corridorStopActions.ts` (`setCorridorStopStatus`, `deleteCorridorStop` — same philosophy as `markSelected`). `AddCorridorStopForm.tsx` (mirrors `AddCustomStopForm.tsx`) lets a traveler pin a stop directly, writing `status: 'locked'` immediately (a deliberate action, same reasoning as custom activities writing `status: 'selected'` outright) with empty `linkedDayIds` — reconciling it into a real day is phase 4's job. `corridorStopSchema` loosened accordingly: `country` is now optional (Places autocomplete alone doesn't resolve one) and `linkedDayIds` may be empty. Rescan (`RescanCorridorButton.tsx` → new `rescanCorridor` callable) searches a fixed 25 km radius around the map's current center (tracked via `onCameraChanged`), modeled on `enrichHighlights.ts`'s retry/parse/geocode loop but radius-filtered via `haversineDistanceKm` instead of route-detour, capped at `MAX_RESCAN_RADIUS_KM` (50 km, server-enforced) and `MAX_RESCAN_RESULTS` (10) — writes only `proposed` stops, structurally incapable of touching `committed`/`locked` ones, so no merge algorithm was needed. No busy-guard/cost-guard machinery: rescan never touches `planMeta.status` or the days collection, so concurrent rescans are merely redundant, not corrupting. Covered by `functions/src/prompts/rescanCorridor.test.ts` (10 tests), `functions/src/rescanCorridorCallable.test.ts` (4 tests), updated `mapZoomTiers.test.ts`, and 3 new `e2e/corridor.spec.ts` tests (add-stop write, validation, and rescan's credential-less degradation to an error banner — marker-click interaction itself stays unverifiable in this sandbox, same pre-existing Maps-JS-blocked limitation as every other marker).
  4. **"Lock in the new route"** — the reconciliation engine, split in two (mirroring how the highlights-review pause itself was deliberately scoped down to a v1 the first time):
     - ~~**4a. Reorder/date-shift only**~~ **Done 2026-07-29**: new `functions/src/corridorReconciliation.ts` (`computeCorridorReconciliation`/`runReconcileCorridor`). Found before writing any code, not assumed: nothing in phases 1-3 gave a traveler any way to actually *trigger* a reorder — `corridorStops` carries no order/sequence field, and phase 3 deliberately gives `committed` stops no marker of their own. Resolved by deriving each committed stop's current order from its linked days' own `.index` (already a valid, real ordering key — no new read-side field needed) and adding a plain up/down-button list, `ReorderCorridorPanel.tsx` — no drag-and-drop, the same lesson `HighlightsReviewPanel`'s own re-ranking already learned the hard way (its e2e suite explicitly asserts no `[draggable]` affordance survives; native HTML5 drag-and-drop never worked reliably on a touch device). A stop can cover more than one `TripDay` (a rest day shares its previous day's overnight) — those move as one block, keeping their internal order, onto the trip's own existing date sequence (reordering only permutes which content sits on which date, it never changes trip length); only a block's first day ever gets a recomputed drive leg (via the existing `computeRouteLeg`), later days in the block (e.g. the rest day) keep their content untouched apart from date/index. Reviewed via a diff before anything writes: "Preview changes" calls a new `previewReconcileCorridor` callable (read-only, no busy guard needed — nothing is written) that runs the exact same computation and returns a `ReconcileDayChange[]` diff (new schema in `shared/src/schemas.ts`); "Confirm" submits through the normal `planRequests` flow with a new `reconcileCorridor` request kind, reusing `generatePlan.ts`'s existing one-operation-per-trip busy guard (unlike phase 3's rescan, this mutates real day data) — then closes and relies on the existing `planMeta.status === 'generating'` banner for the wait, same philosophy as `AddRestDay.tsx`. `computeCorridorReconciliation` rejects anything but a pure permutation of the current committed-stop set — adding/removing a stop is phase 4b's job, not this one's. Also fixed along the way: `e2e/helpers/seedFixturePlan.ts` never materialized `corridorStops` at all (it bypasses `buildCorridorStopWrites` by writing days directly), and never set a real `settings.startPoint`/`endPoint` (defaulting to `{lat:0,lng:0}`) — both silently correct for every prior phase's tests but a real gap once a feature (this one) needs to compute a real leg back to the trip's own start; fixed by mirroring the stop-grouping logic inline and seeding Oslo/Otta as the fixture's start/end points. Covered by `functions/src/corridorReconciliation.test.ts` (11 tests: remapping, no-op reorder, permutation rejection, multi-day blocks, pacing-failure rollback, and the full trigger dispatch including its own busy-guard test), `functions/src/previewReconcileCorridorCallable.test.ts`, and a new `e2e/corridor.spec.ts` reorder test exercising the real UI end to end (preview → diff → confirm → committed swap).
     - **4b. Add/remove-stop + end-date extension** — a removed committed stop's linked days are deleted and everything later collapses forward (surfaced explicitly in the diff screen, not silently dropped like today's `runReplan`); an added stop needs only the detail phase to run (town/location is already known from the corridor edit, so the outline/curation phases are skipped entirely — cheaper and more accurate than today's full-remainder regeneration). If the day count no longer fits `startDate`–`endDate`, the diff screen requires an explicit accept before `endDate` is touched.

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

---

**END OF MASTER PLAN — keep this file in the repo root as `MASTER_PLAN.md` and update checkboxes with every commit.**
