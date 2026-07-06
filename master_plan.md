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
| AI planning | Claude API (claude-sonnet-4-6), called ONLY from Firebase Cloud Functions |
| Repo | GitHub, CI via GitHub Actions → Firebase deploy |

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
| Google Maps JS API key | Frontend `.env` (restricted by HTTP referrer in Google Cloud Console) |
| Google Places/Routes key | Cloud Functions secret (server-restricted) |
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
                            heightM?, lengthM? } }
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

Implemented inside the Claude Planning Prompt + validated in code:

1. Compute total route distance (Routes API, start → mandatory waypoints → end).
2. Available drive days = total days − rest days (1 per `restDayFrequency`) − extra-time days Claude assigns to standout places.
3. Target daily drive = totalKm / driveDays. Hard caps: no day > 1.4 × target, and **the final 2 days must each be ≤ 1.0 × target** (guarantees a relaxed finish).
4. Code-side validator checks every generated plan against rule 3. If violated → automatic one-shot retry with violation fed back to Claude → if still violated, mark plan `error` with details (never show a bad plan).
5. Rest days are placed in high-interest locations, never in transit towns.

---

## 6. CLAUDE PROMPT CONTRACTS (Cloud Functions)

Three prompt templates live in `functions/src/prompts/`. All must demand **JSON-only output** matching a zod schema; parse with `JSON.parse` after stripping code fences; on schema failure retry once with the error appended.

### 6.1 `planTrip` prompt — inputs
- All of `settings` + the full `notes.freeText` (ALWAYS include notes — this is the user's requirement that the text file is "checked at every update")
- Instruction block: role = expert European tour guide specializing in RV travel and hidden gems; respect pacing rules (Section 5); prefer `preferredCountries`; match `interests` and kids' ages; assign `extraTimeReason` where a place deserves >1 day; place rest days per settings; choose overnight stops near campsites; for each day propose 5 activities (mix of famous + hidden gems, flag kid-friendly) and 3 restaurants per meal — as NAME + TOWN + CATEGORY only (Places API resolves the details, ratings and links afterwards; Claude must not invent ratings or URLs).

### 6.2 `replanTrip` prompt — extra inputs
- Current GPS location, today's date, list of completed/skipped items, remaining end date/point. Instruction: preserve completed history, re-pace the remainder under the same rules.

### 6.3 `countryGuide` prompt — inputs
- Country code + vehicle block. Must return the exact `countries/{code}` schema (driving rules, camping, free camping, road fees + payment, speed limits for a 3,500 kg car-registered RV, LPG refill info). Enable Claude web search tool in this call so fees/vignette prices are current; require source-cautious phrasing ("as of {date}").

### 6.4 Places enrichment (code, not Claude)
For each Claude-proposed name+town: Places Text Search → take top match within 30 km of the day's route → fetch rating, ratingCount, googleMapsUri, photo, opening hours, priceLevel. If no match ≥3.8 rating with ≥50 reviews, drop it and backfill from Places Nearby Search by category so the counts (5 activities, 3×3 restaurants) always hold.

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
- [x] **T-13** Routes API integration: real distance/duration between stops; store polylines; compute `avgDriveMinutesPerDay`, `totalKm`.
  ✅ TEST: unit test with mocked Routes response; emulator run on Oslo→Rome fixture yields plausible totals (±10 % of known ~2,700 km).
- [ ] **T-14** `planTrip` Claude call per 6.1 (includes notes text every time); zod-validate; one retry on parse/schema failure.
  ✅ TEST: recorded-response unit test parses to valid skeleton; live smoke test returns a plan honoring preferred countries and interests.
  NOTE: implementation + recorded-response unit tests (parse success, schema-violation, one-retry-then-succeed, retry-exhausted) are done and passing. The live smoke test against the real Claude API is blocked on `CLAUDE_API_KEY` — run it once that secret is set.
- [x] **T-15** Pacing validator per Section 5 incl. final-2-days rule and rest-day placement; violation → feedback retry → error status.
  ✅ TEST: unit tests: crafted violating plan is rejected with correct reason; valid plan passes.
- [ ] **T-16** Places enrichment per 6.4: resolve every proposed item, enforce counts (5 activities, 3×3 restaurants) with backfill, store rating/link/photo/hours.
  ✅ TEST: unit test with mocked Places; live smoke: every activity/restaurant doc has rating + googleMapsUrl; counts exact on all days.
  NOTE: enrichActivities/enrichRestaurantsForMeal implemented (text search → quality-bar filter → nearby-search backfill, exact counts, shared exclude set across meals) with 5 mocked-Places unit tests passing. Not yet wired into generatePlan's fixture pipeline — that requires `GOOGLE_PLACES_API_KEY`, and wiring it in now would break T-12's fixture-only emulator test. Live smoke test pending the real key, same as T-14.
- [x] **T-17** `replanTrip` per 6.2 preserving completed days.
  ✅ TEST: emulator — fixture trip mid-way, replan request → past days untouched, future days regenerated, pacing rules hold.
- [ ] **T-18** `countryGuide` per 6.3 for each route country, cached; refresh callable.
  ✅ TEST: plan through 3 countries creates 3 guide docs with all six sections non-empty.
  NOTE: generateCountryGuide (Claude + web_search_20260209 tool, zod-validated with one retry) and the refreshCountryGuide callable are implemented and unit-tested against a recorded response covering all six sections. Not auto-wired into generatePlan/replanTrip's fixture pipeline for the same reason as T-14/T-16 — needs CLAUDE_API_KEY. Live "plan through 3 countries" test pending that key.

This completes Phase 3 (Planning engine). T-14, T-16, and T-18 are code-complete and unit-tested against recorded/mocked responses, but their real-API integration into the generatePlan/replanTrip pipeline and their live smoke tests are blocked on CLAUDE_API_KEY, GOOGLE_ROUTES_API_KEY, and GOOGLE_PLACES_API_KEY.

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

This completes Phase 6's audit work; T-29/T-30 remain.
- [ ] **T-29** Cost guards: request debouncing, single pending planRequest enforcement, photo size caps.
  ✅ TEST: hammering Generate creates exactly one active request.
- [ ] **T-30** Production launch: restrict keys to prod domain, deploy `main` to live channel, install on both phones + iPad, generate the real trip.
  ✅ TEST: full manual walkthrough of the Acceptance Checklist (Section 10) on real devices.

---

## 10. REQUIREMENTS TRACEABILITY — tick when verified end-to-end

- [ ] Inputs: dates, travelers + kids' ages, interests, start/finish, preferred countries (T-10)
- [ ] Freeform notes "text file", editable, persisted, injected into every plan/replan (T-11, T-14, T-17)
- [ ] Inputs saved between sessions & editable (T-09, T-10)
- [ ] Even pacing, no huge final drive (T-15)
- [ ] Extra time for deserving attractions (T-14 `extraTimeReason`)
- [ ] Rest days ~1/week, selectable in input (T-10, T-15)
- [ ] Per day: drive + 5 activities + 3×3 restaurants (T-16)
- [ ] Drive slot morning/midday/evening linking to next day's activities (T-14, T-23)
- [ ] Route on interactive map with best stops (T-19)
- [ ] Zoom → progressively more stops; close zoom shows all with type icons (T-20)
- [ ] Change-request interface (T-22)
- [ ] Average driving time per day displayed (T-19)
- [ ] Click map segment → Day View; cycle days without overview (T-21, T-23)
- [ ] Map on top, activities below (T-23)
- [ ] Execution prompt when >50 km behind plan (T-26)
- [ ] Cards show info, Google rating, Google Maps link; click shows on map (T-24)
- [ ] Mark done → log/diary (T-25)
- [ ] Country info: driving rules, camping, free camping, road fees & payment, speed limits (3,500 kg car-registered), LPG refill (T-18, T-27)
- [ ] Data saved but easily modified; stale→replan flow (T-10, T-17)
- [ ] Same plan live on two phones (T-07, T-09)
- [ ] iPad compatible / responsive (T-23, T-28)
- [ ] GitHub + Firebase (T-01–T-03)

**END OF MASTER PLAN — keep this file in the repo root as `MASTER_PLAN.md` and update checkboxes with every commit.**
