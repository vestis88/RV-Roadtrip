import { defineSecret } from 'firebase-functions/params'
import { haversineDistanceKm } from '@rv/shared'
import type {
  Activity,
  ActivityCategory,
  LatLng,
  Meal,
  OvernightStopCandidate,
  Restaurant,
} from '@rv/shared'

export const googlePlacesApiKey = defineSecret('GOOGLE_PLACES_API_KEY')

/**
 * The floor a place Claude NAMED must clear to be accepted as itself.
 *
 * This gate exists to reject the wrong place, not to second-guess the
 * suggestion: Claude picks from the traveler's interests and freeform notes,
 * Places verifies that the named place exists, is where it should be, and
 * isn't a dud. 3.8/50 is the long-standing figure and stays put for
 * activities — a 3.8 hiking area or museum is a perfectly good day out.
 *
 * Restaurants get their own, higher floor. Google's restaurant ratings
 * cluster high, so a 3.8 restaurant sits below the median and reads to a
 * traveler as mediocre in a way a 3.8 museum does not — which is what "why
 * so many with half good reviews if a top 3 is picked?" was about. Below 4.0
 * we would rather drop the suggestion and fill the slot from the ladder
 * below, which starts far higher.
 */
const MIN_RATING = 3.8
const MIN_RESTAURANT_RATING = 4.0
const MIN_RATING_COUNT = 50
const SEARCH_RADIUS_METERS = 30_000
const ACTIVITIES_PER_DAY = 5
const RESTAURANTS_PER_MEAL = 3
/**
 * How many category slots backfillActivities may try before giving up.
 *
 * Must comfortably exceed the number of categories, not merely match it.
 * The loop takes one category per attempt and a category with nothing usable
 * nearby costs an attempt without filling a slot — which is the normal case
 * inland, where there is no beach and often no museum. At exactly one
 * rotation, a rural day that misses on three categories can only ever return
 * five of its seven slots, and adding a category (bike, ski) would silently
 * make that worse rather than better. Two rotations cost nothing in API
 * calls, since each category's pool is fetched at most once however many
 * attempts land on it.
 */
const MAX_BACKFILL_ATTEMPTS = 16
// Dismiss-and-requeue (implemented 2026-07-30): a couple of extra
// activities/restaurants resolved at generation time, alongside the
// displayed count, and stored with reserve: true (see activitySchema's own
// comment) — an instant, no-round-trip swap-in when a traveler skips a
// displayed item, rather than either a gap or a live Places call on every
// dismiss.
const RESERVE_ACTIVITY_COUNT = 2
const RESERVE_RESTAURANTS_PER_MEAL = 1
// Once both the displayed items AND their reserve are exhausted for a given
// day/meal, researchMoreAlternativesCallable.ts tops the pool back up by
// this many — see that file for the full flow.
export const RESEARCH_BATCH_SIZE = 3

// Places API (New) rejects 'point_of_interest'/'establishment' as an
// includedTypes value for searchNearby (they're Text-Search-only generic
// types) — 'other' maps to undefined so nearbySearch omits the type filter
// entirely instead of sending an invalid value and getting a 400.
const ACTIVITY_PLACE_TYPE: Record<ActivityCategory, string | undefined> = {
  sight: 'tourist_attraction',
  hike: 'hiking_area',
  museum: 'museum',
  beach: 'beach',
  playground: 'playground',
  bike: 'cycling_park',
  ski: 'ski_resort',
  other: undefined,
}

const MEAL_PLACE_TYPE: Record<Meal, string> = {
  breakfast: 'cafe',
  lunch: 'restaurant',
  dinner: 'restaurant',
}

interface PlaceCandidate {
  id: string
  name: string
  lat: number
  lng: number
  rating?: number
  ratingCount?: number
  googleMapsUrl?: string
  photoUrl?: string
  openingHours?: string[]
  priceLevel?: number
  /** Google's own one-line description of the place, when it has one. */
  editorialSummary?: string
}

interface RawPlace {
  id: string
  displayName?: { text?: string }
  location?: { latitude?: number; longitude?: number }
  rating?: number
  userRatingCount?: number
  googleMapsUri?: string
  photos?: { name: string }[]
  regularOpeningHours?: { weekdayDescriptions?: string[] }
  priceLevel?: string
  editorialSummary?: { text?: string }
}

interface PlacesSearchResponse {
  places?: RawPlace[]
}

const PRICE_LEVEL_MAP: Record<string, number> = {
  PRICE_LEVEL_FREE: 0,
  PRICE_LEVEL_INEXPENSIVE: 1,
  PRICE_LEVEL_MODERATE: 2,
  PRICE_LEVEL_EXPENSIVE: 3,
  PRICE_LEVEL_VERY_EXPENSIVE: 4,
}

function mapRawPlace(raw: RawPlace, apiKey: string): PlaceCandidate {
  return {
    id: raw.id,
    name: raw.displayName?.text ?? '',
    lat: raw.location?.latitude ?? 0,
    lng: raw.location?.longitude ?? 0,
    rating: raw.rating,
    ratingCount: raw.userRatingCount,
    googleMapsUrl: raw.googleMapsUri,
    photoUrl: raw.photos?.[0]
      ? `https://places.googleapis.com/v1/${raw.photos[0].name}/media?key=${apiKey}&maxWidthPx=400`
      : undefined,
    openingHours: raw.regularOpeningHours?.weekdayDescriptions,
    priceLevel: raw.priceLevel ? PRICE_LEVEL_MAP[raw.priceLevel] : undefined,
    editorialSummary: raw.editorialSummary?.text,
  }
}

/** A rating floor paired with the number of reviews that floor is trusted at. */
interface QualityBar {
  minRating: number
  minRatingCount: number
}

const PLACE_VERIFY_BAR: QualityBar = {
  minRating: MIN_RATING,
  minRatingCount: MIN_RATING_COUNT,
}

const RESTAURANT_VERIFY_BAR: QualityBar = {
  minRating: MIN_RESTAURANT_RATING,
  minRatingCount: MIN_RATING_COUNT,
}

/**
 * Admits everything, for the one caller that must not judge quality:
 * verifyPlaceLocation is locating a named sight, and a small trailhead or a
 * village church may have no ratings at all and still be exactly right.
 * Expressed as a bar rather than as a branch so that path shares one
 * definition of "usable match" with every other, instead of drifting into a
 * second copy of the distance and name checks — which is what it was.
 */
const NO_QUALITY_BAR: QualityBar = { minRating: 0, minRatingCount: 0 }

/**
 * What a slot is filled with when Claude's suggestion could not be verified.
 *
 * The traveler was asked whether an unfindable suggestion should become a
 * generic stand-in or simply not appear, and answered: "Fill up with results
 * from google, but I want top rated alternatives!" So every slot still gets
 * filled — and since every filler is now chosen by this code rather than by
 * anyone's judgement of the trip, the bar it is chosen against is the whole
 * promise.
 *
 * Each rung is tried in order and the first one that yields anything wins,
 * with `bestCandidate` ordering within it. The rungs trade review count away
 * before they trade rating away, because the two numbers fail differently:
 *
 * - Rating is the thing being promised. 4.3 is meaningfully "top rated"
 *   without being unreachable; the old 3.8 was picked as a bare floor when
 *   it was one filter among several, and as the gate on every filled slot it
 *   promises far too little.
 * - Review count is a confidence requirement, not a quality one. A 5.0 from
 *   six reviews is noise, so 100 reviews are demanded first; where a town
 *   simply does not have places that busy, 30 and then 10 are accepted
 *   rather than leaving a day with no dinner options at all. Note that more
 *   reviews are never treated as BETTER — that assumption is exactly what
 *   served a 9,125-review shopping mall as lunch.
 *
 * Restaurants keep their own ladder so nothing below MIN_RESTAURANT_RATING
 * is ever offered: it would be incoherent to drop a named 3.9 restaurant for
 * being under the floor and then fill its slot with a 3.8 one.
 */
const PLACE_QUALITY_LADDER: QualityBar[] = [
  { minRating: 4.3, minRatingCount: 100 },
  { minRating: 4.0, minRatingCount: 30 },
  { minRating: MIN_RATING, minRatingCount: 10 },
]

const RESTAURANT_QUALITY_LADDER: QualityBar[] = [
  { minRating: 4.3, minRatingCount: 100 },
  { minRating: 4.1, minRatingCount: 30 },
  { minRating: MIN_RESTAURANT_RATING, minRatingCount: 10 },
]

function meetsQualityBar(
  candidate: PlaceCandidate,
  bar: QualityBar = PLACE_VERIFY_BAR,
): boolean {
  return (
    (candidate.rating ?? 0) >= bar.minRating &&
    (candidate.ratingCount ?? 0) >= bar.minRatingCount
  )
}

/**
 * How far from the day's anchor a text-search result is still allowed to be.
 *
 * Places' `locationBias` (what textSearch sends) is a *preference*, not a
 * bound — with nothing matching nearby it will happily answer with the best
 * match on another continent, and nothing downstream was checking. That is
 * how a dinner stop for a night in Helsingør ended up being a hotel in
 * Greece: Claude proposed a name, no such place existed in Denmark, and a
 * well-rated Greek namesake cleared the quality bar unopposed.
 *
 * Same figure as the bias radius, now enforced rather than merely requested.
 */
const MAX_MATCH_DISTANCE_KM = SEARCH_RADIUS_METERS / 1000

/** Words that carry no identifying signal when comparing two place names. */
const NAME_STOPWORDS = new Set([
  'the', 'a', 'an', 'de', 'den', 'det', 'der', 'die', 'das', 'la', 'le', 'les',
  'el', 'il', 'restaurant', 'restaurang', 'cafe', 'café', 'kafe', 'bar',
  'hotel', 'hotell', 'museum', 'museet', 'park', 'parken', 'and', 'og', 'och',
  'und', 'et', 'y', 'i', 'in', 'at', 'of', 'på',
])

/**
 * Tokenises a place name for comparison: case-folded, diacritics stripped
 * (so "Møns" and "Mons" agree), punctuation dropped, and the generic nouns
 * above removed — "Restaurant Sletten" and "Sletten" are the same place, and
 * matching on the word "restaurant" would let any restaurant satisfy any
 * other.
 */
function nameTokens(name: string): string[] {
  return name
    .toLowerCase()
    // Letters that NFD does NOT decompose, because they are letters in their
    // own right rather than a base plus an accent. Unhandled, the strip below
    // deletes them outright and "M\u00f8ns Klint" tokenises to ["ns", "klint"] \u2014
    // which then fails to match Places' own "Mons Klint". Very much not an
    // edge case for a trip planner whose corridor is Scandinavia.
    .replace(/\u00f8/g, 'o')
    .replace(/\u00e6/g, 'ae')
    .replace(/\u00f0/g, 'd')
    .replace(/\u00fe/g, 'th')
    .replace(/\u00df/g, 'ss')
    .replace(/\u0142/g, 'l')
    .replace(/\u0111/g, 'd')
    // Everything else (\u00e5, \u00e4, \u00f6, \u00e9, \u00fc, \u2026) is a base letter plus a combining
    // mark once decomposed, so dropping the marks leaves the letter behind.
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter((token) => token.length > 1 && !NAME_STOPWORDS.has(token))
}

/**
 * Whether a Places result is plausibly the place that was asked for.
 *
 * Distance alone does not catch every wrong match, because the worst ones are
 * local: asked for a small café near Berlin, Places returned "Designer Outlet
 * Berlin" — 30,000 ratings, comfortably inside the radius, and nothing like
 * what was requested. The quality bar actively causes this, since it prefers
 * exactly the famous places that outrank the modest one that was meant.
 *
 * Half of the requested name's identifying words must appear in the result's,
 * with a floor of one — forgiving enough that Places' fuller listing name
 * ("Kronborg Castle" for "Kronborg") still matches, strict enough that an
 * unrelated landmark does not. Requesting nothing identifiable (a bare
 * category, as the backfill paths do) skips the check rather than failing it:
 * those callers are asking for "a good museum near here", where any museum is
 * a correct answer.
 */
/**
 * What KIND of place a name says it is, by the words in it.
 *
 * Reported 2026-08-17 with a screenshot: a card headed "Bruzaholms Gokart" —
 * a go-kart track, per Google's own listing — carrying a description of a
 * lift-free downhill and enduro trail network, filed under the interest
 * "mountain biking". Nothing had gone wrong with the description. Curation
 * proposed a mountain-bike spot in Bruzaholm; Places was asked for it, and
 * answered with the best-known business in that village that shares its
 * name.
 *
 * The name check let it through, and the arithmetic is the whole story:
 * half of the requested words had to be found, floor of one, so a
 * two-word name needed ONE match. "Place + category" is the commonest shape
 * a sight name takes, and under that rule the place name alone was enough —
 * leaving the category word, the only word that says what the thing IS, free
 * to be anything at all.
 *
 * No amount of string arithmetic separates "Kronborg Slot" → "Kronborg
 * Castle" (right, a translation) from "Bruzaholms MTB" → "Bruzaholms Gokart"
 * (wrong, a different sport): both share one word and differ in one. The
 * missing signal is that slot and castle mean the same thing and MTB and
 * gokart do not, so that is what this encodes.
 *
 * Deliberately a small, explicit table rather than anything cleverer. It is
 * used in two directions — as equivalence, so a translated category still
 * matches, and as conflict, so two DIFFERENT categories reject outright —
 * and a word that is in no group simply carries no category signal, which
 * leaves the existing behaviour exactly as it was.
 */
const CATEGORY_GROUPS: Record<string, string[]> = {
  castle: ['slot', 'slott', 'castle', 'schloss', 'borg', 'fastning', 'fortress', 'festning', 'palace', 'palats'],
  church: ['kyrka', 'kyrkan', 'kirke', 'kirche', 'church', 'domkyrka', 'katedral', 'cathedral', 'kloster', 'abbey'],
  bike: ['mtb', 'cykel', 'bike', 'biking', 'sykkel', 'downhill', 'enduro', 'bikepark', 'singletrack'],
  gokart: ['gokart', 'gocart', 'kart', 'karting', 'gokartbana'],
  motorsport: ['motorbana', 'racetrack', 'raceway', 'speedway', 'motocross'],
  golf: ['golf', 'golfbana', 'golfklubb'],
  zoo: ['zoo', 'djurpark', 'dyrepark', 'tierpark', 'safaripark', 'akvarium', 'aquarium'],
  waterpark: ['badhus', 'simhall', 'vattenland', 'aquapark', 'badeland', 'waterpark', 'tropikariet'],
  ski: ['skid', 'slalom', 'alpint', 'skisenter', 'skianlaggning', 'skiing', 'liftsystem'],
  beach: ['strand', 'beach', 'badplats', 'stranden'],
  cave: ['grotta', 'grotte', 'cave', 'hule'],
  lighthouse: ['fyr', 'fyren', 'lighthouse', 'leuchtturm'],
  waterfall: ['vattenfall', 'foss', 'fossen', 'waterfall', 'wasserfall'],
  climbing: ['klattring', 'klatring', 'climbing', 'klettersteig', 'via ferrata'],
  themepark: ['tivoli', 'nojespark', 'fornoyelsespark', 'freizeitpark', 'themepark'],
  campsite: ['camping', 'campingplats', 'campingplass', 'stellplatz', 'ställplats'],
}

/**
 * Short keywords are matched whole; longer ones are matched inside a word
 * too, because Scandinavian names compound relentlessly —
 * "Bergscykelpark" and "Gokartbana" are one token each and would otherwise
 * carry no category at all. Four characters is the point where a substring
 * stops being likely to appear by accident.
 */
const CATEGORY_SUBSTRING_MIN = 4

const CATEGORY_OF_KEYWORD = new Map<string, string>(
  Object.entries(CATEGORY_GROUPS).flatMap(([group, words]) =>
    words.map((word) => [word, group] as [string, string]),
  ),
)

/**
 * Raw words of a name — case-folded and de-accented like nameTokens, but
 * with NOTHING removed. Category detection has to see the words nameTokens
 * drops as noise ("park", "museum"), because for this question they are the
 * signal rather than the noise.
 */
function rawTokens(name: string): string[] {
  return name
    .toLowerCase()
    .replace(/ø/g, 'o')
    .replace(/æ/g, 'ae')
    .replace(/ß/g, 'ss')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean)
}

/** The category one word states, if any — exact for short keywords, inside
 * the word for longer ones. The single place that rule lives, so detection
 * and equivalence cannot disagree about what a word means. */
function categoryOfToken(token: string): string | undefined {
  for (const [keyword, group] of CATEGORY_OF_KEYWORD) {
    if (
      token === keyword ||
      (keyword.length >= CATEGORY_SUBSTRING_MIN && token.includes(keyword))
    ) {
      return group
    }
  }
  return undefined
}

function categoriesIn(name: string): Set<string> {
  const found = new Set<string>()
  for (const token of rawTokens(name)) {
    const group = categoryOfToken(token)
    if (group) found.add(group)
  }
  return found
}

/**
 * Nordic names take a genitive -s that Places' own listing often drops, or
 * adds: "Lunds Domkyrka" is listed as "Lund Cathedral", "Kolmårdens" as
 * "Kolmården". Compared literally these are different words, and the whole
 * place name is exactly the word a match cannot afford to lose. Only ever
 * loosens, and only for the comparison — the stored name is still Places'.
 */
function withoutGenitive(token: string): string {
  return token.length > 3 && token.endsWith('s') ? token.slice(0, -1) : token
}

/**
 * True when both names say what kind of place they are and disagree.
 *
 * One-directional silence is not disagreement: a result that names no
 * category ("Bruzaholm") contradicts nothing, and neither does a request
 * that names none. Only two stated, different answers reject — which is the
 * go-kart track standing in for a bike park, and nothing else.
 */
function categoryConflict(expectedName: string, actual: string): boolean {
  const wanted = categoriesIn(expectedName)
  if (wanted.size === 0) return false
  const got = categoriesIn(actual)
  if (got.size === 0) return false
  return ![...wanted].some((group) => got.has(group))
}

/**
 * How many of the requested name's identifying words the result actually
 * has. A word whose category the result states in another language counts:
 * that is what keeps "Kronborg Slot" matching "Kronborg Castle" under the
 * stricter threshold below.
 */
function nameMatchHits(expected: string[], actual: string): number {
  const found = new Set(nameTokens(actual))
  const stems = new Set([...found].map(withoutGenitive))
  const actualCategories = categoriesIn(actual)
  return expected.filter((token) => {
    if (found.has(token) || stems.has(withoutGenitive(token))) return true
    const group = categoryOfToken(token)
    return group !== undefined && actualCategories.has(group)
  }).length
}

/**
 * How much of the requested name has to be found.
 *
 * Everything, for a name of one or two identifying words — because at two
 * words "half" meant the place name on its own, and that is precisely the
 * hole the go-kart track came through.
 *
 * Longer names are back to half (2026-08-18). Tightening those to
 * all-but-one went with the two-word fix for symmetry rather than because
 * any failure asked for it, and it cost more than it bought: a proposal that
 * fails verification is not shown as a gap, it is silently replaced by the
 * best-rated thing of its kind nearby with a template blurb, and the day
 * reads blander with nothing to say why. Reported as "the descriptions for
 * activities seem to have become quite generic". The category-conflict check
 * above is what actually caught the go-kart track, and it is untouched.
 */
function requiredNameHits(expectedCount: number): number {
  return expectedCount <= 2
    ? expectedCount
    : Math.max(1, Math.ceil(expectedCount / 2))
}

function nameLooksRight(expectedName: string | undefined, actual: string): boolean {
  if (!expectedName) return true
  // Checked before the word count, and independently of it: two names can
  // agree on every word they share and still be a bike park and a go-kart
  // track.
  if (categoryConflict(expectedName, actual)) return false
  const expected = nameTokens(expectedName)
  if (expected.length === 0) return true
  return nameMatchHits(expected, actual) >= requiredNameHits(expected.length)
}

/**
 * How closely a result's name matches the requested one, 0..1 — the same
 * comparison nameLooksRight gates on, kept as a number so two results that
 * both pass the gate can be ordered by how well they match.
 *
 * Shared words over ALL words (the union), not over the requested ones,
 * because words the result adds are evidence against it: asked for
 * "Restaurant Sletten", both "Sletten" and "Sletten Bageri og Konditori"
 * contain every identifying word requested, but the bakery is a different
 * business and scores 1/3 against the restaurant's 1. Without that, a
 * well-rated namesake next door outranks the place actually asked for as
 * soon as ratings enter the comparison.
 *
 * Asking for nothing identifiable (the category searches) scores everything
 * equally, which leaves quality alone deciding — exactly what those callers
 * want.
 */
function nameMatchScore(expectedName: string | undefined, actual: string): number {
  if (!expectedName) return 1
  const expected = nameTokens(expectedName)
  if (expected.length === 0) return 1
  const hits = nameMatchHits(expected, actual)
  const union = expected.length + (new Set(nameTokens(actual)).size - hits)
  return hits / union
}

/**
 * The single gate every text-search result must pass before it is accepted as
 * the place a plan asked for. Nearby-search results skip the distance and
 * name checks by construction: that path uses `locationRestriction` (a real
 * bound) and asks by category rather than by name.
 */
function isUsableMatch(
  candidate: PlaceCandidate,
  near: LatLng,
  expectedName: string | undefined,
  excludeIds: Set<string>,
  bar: QualityBar,
  maxDistanceKm: number = MAX_MATCH_DISTANCE_KM,
): boolean {
  return (
    meetsQualityBar(candidate, bar) &&
    !excludeIds.has(candidate.id) &&
    haversineDistanceKm(near, { lat: candidate.lat, lng: candidate.lng }) <=
      maxDistanceKm &&
    nameLooksRight(expectedName, candidate.name)
  )
}

/**
 * The best of the results Places returned, or undefined if none is usable.
 *
 * Every path used to take the FIRST result clearing the bar, which meant the
 * bar was doing all the work and Places' own ordering decided the rest. That
 * ordering is prominence — how well known a place is — so a lunch stop came
 * back as "BIG Shopping": a shopping centre, 3.8 stars, 9,125 reviews, the
 * single most prominent thing anywhere near the town. Prominence is
 * popularity, and popularity is not quality; a mall out-ranks every small
 * kitchen in the country and always will.
 *
 * Ordering, in priority order:
 *
 * 1. Name match, when a name was asked for. Identity beats quality: a
 *    better-rated near-namesake is still the wrong place, and swapping it in
 *    is the same class of bug as the Greek hotel and the Berlin outlet.
 * 2. Rating, among places that match equally well.
 * 3. Rating count, purely as a tie-break — of two 4.6s, the one with 800
 *    reviews is the more certain 4.6.
 *
 * Rating count stays a hard floor (MIN_RATING_COUNT) rather than a term in a
 * score, because the thing it excludes is noise, not mediocrity: a 5.0 from
 * six reviews carries no information at all, and no amount of weighting
 * turns six reviews into evidence. Above that floor, more reviews are not
 * better — that is precisely the assumption that produced the mall.
 */
function bestCandidate(
  candidates: PlaceCandidate[],
  near: LatLng,
  expectedName: string | undefined,
  excludeIds: Set<string>,
  bar: QualityBar,
  maxDistanceKm: number = MAX_MATCH_DISTANCE_KM,
): PlaceCandidate | undefined {
  return candidates
    .filter((candidate) =>
      isUsableMatch(candidate, near, expectedName, excludeIds, bar, maxDistanceKm),
    )
    .sort(
      (a, b) =>
        nameMatchScore(expectedName, b.name) - nameMatchScore(expectedName, a.name) ||
        (b.rating ?? 0) - (a.rating ?? 0) ||
        (b.ratingCount ?? 0) - (a.ratingCount ?? 0),
    )[0]
}

/**
 * The best place in a pool, walking the ladder from "top rated" down and
 * stopping at the first rung that has anything in it. Relaxing the rung only
 * when the one above it is empty is what keeps a rural stretch of road from
 * ending up with no dinner options while still handing a town with real
 * choice its genuinely top-rated ones.
 */
function bestFromLadder(
  pool: PlaceCandidate[],
  near: LatLng,
  excludeIds: Set<string>,
  ladder: QualityBar[],
): PlaceCandidate | undefined {
  for (const bar of ladder) {
    const match = bestCandidate(pool, near, undefined, excludeIds, bar)
    if (match) return match
  }
  return undefined
}

/**
 * Exported for unit tests only. The matching gate is pure string/geometry
 * work with no network in it, which is exactly the part worth testing
 * directly — the wrong-place bugs it exists to stop were reported from
 * production, where reproducing them means a real Places round trip.
 */
export const __testing = {
  nameTokens,
  nameLooksRight,
  nameMatchScore,
  bestCandidate,
  bestFromLadder,
  PLACE_VERIFY_BAR,
  RESTAURANT_VERIFY_BAR,
  PLACE_QUALITY_LADDER,
  RESTAURANT_QUALITY_LADDER,
}

// places.editorialSummary added 2026-08-18: it is what a substitute card
// says about itself instead of "A well-rated local hike." The mask already
// asks for ratings, photos and opening hours, so this is not the field that
// decides what tier the request is billed at.
const FIELD_MASK =
  'places.id,places.displayName,places.location,places.rating,places.userRatingCount,places.googleMapsUri,places.photos,places.regularOpeningHours.weekdayDescriptions,places.priceLevel,places.editorialSummary'

async function textSearch(
  query: string,
  near: LatLng,
  apiKey: string,
): Promise<PlaceCandidate[]> {
  const response = await fetch(
    'https://places.googleapis.com/v1/places:searchText',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': apiKey,
        'X-Goog-FieldMask': FIELD_MASK,
      },
      body: JSON.stringify({
        textQuery: query,
        locationBias: {
          circle: {
            center: { latitude: near.lat, longitude: near.lng },
            radius: SEARCH_RADIUS_METERS,
          },
        },
      }),
    },
  )
  if (!response.ok) {
    const body = await response.text().catch(() => '')
    throw new Error(
      `Places text search failed with ${response.status}: ${body.slice(0, 500)}`,
    )
  }
  const data = (await response.json()) as PlacesSearchResponse
  return (data.places ?? []).map((place) => mapRawPlace(place, apiKey))
}

async function nearbySearch(
  includedType: string | undefined,
  near: LatLng,
  apiKey: string,
): Promise<PlaceCandidate[]> {
  const response = await fetch(
    'https://places.googleapis.com/v1/places:searchNearby',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': apiKey,
        'X-Goog-FieldMask': FIELD_MASK,
      },
      body: JSON.stringify({
        ...(includedType ? { includedTypes: [includedType] } : {}),
        // The API's maximum. A category search is a ranking problem, not a
        // lookup: the more of the neighbourhood's cafés we can see at once,
        // the better the top-rated one we can pick out of them, and 20
        // results cost exactly the same request as 10.
        maxResultCount: 20,
        locationRestriction: {
          circle: {
            center: { latitude: near.lat, longitude: near.lng },
            radius: SEARCH_RADIUS_METERS,
          },
        },
      }),
    },
  )
  if (!response.ok) {
    const body = await response.text().catch(() => '')
    // A 400 here is our own request being wrong, and in practice that means
    // one thing: `includedTypes` carrying a value this API doesn't recognise
    // (see ACTIVITY_PLACE_TYPE's note on why 'other' sends none at all).
    // That is a bug in a single category's mapping, and it must not cost a
    // day every activity it was going to get — the text-search half of
    // categoryPool asks the same question in words and still answers. Every
    // other status still throws: a 401, 403 or 429 is a fact about the whole
    // key, not about this category, and silently degrading it is how an
    // outage becomes "the app just stopped suggesting things".
    if (response.status === 400) {
      console.error(
        `Places nearby search rejected includedTypes "${includedType}" — that category will fall back to text search alone until the mapping is fixed. ${body.slice(0, 500)}`,
      )
      return []
    }
    throw new Error(
      `Places nearby search failed with ${response.status}: ${body.slice(0, 500)}`,
    )
  }
  const data = (await response.json()) as PlacesSearchResponse
  return (data.places ?? []).map((place) => mapRawPlace(place, apiKey))
}

/**
 * Everything Places knows about one KIND of place near a point — "cafés
 * around here" — from both searches at once, deduped.
 *
 * Fetched once per category and then ranked, rather than a fresh search per
 * slot that takes the first acceptable answer and throws the rest away.
 * Filling three lunch slots used to mean three identical text searches, each
 * picking one more of the same prominence-ordered list; now it is one pair
 * of requests and one pool to choose the top-rated three from. Both searches
 * are used because they disagree usefully: text search understands the word
 * "restaurant", nearby search is bounded by an actual radius rather than a
 * preference, and a well-rated place missing from one is regularly in the
 * other.
 */
async function categoryPool(
  query: string,
  includedType: string | undefined,
  near: LatLng,
  apiKey: string,
): Promise<PlaceCandidate[]> {
  const [textResults, nearbyResults] = await Promise.all([
    textSearch(query, near, apiKey),
    nearbySearch(includedType, near, apiKey),
  ])
  const seen = new Set<string>()
  return [...textResults, ...nearbyResults].filter((candidate) => {
    if (seen.has(candidate.id)) return false
    seen.add(candidate.id)
    return true
  })
}

/**
 * Resolves a batch of places the plan asked for BY NAME — verification, not
 * selection. Each item either resolves to the place it named or resolves to
 * nothing; there is deliberately no fallback here.
 *
 * There used to be one, and it is how a lunch stop for a lakeside café came
 * back as "BIG Shopping", a shopping centre with 9,125 reviews, still
 * carrying Claude's description of the café ("Charming lakeside café near
 * the castle"). The name check correctly rejected the wrong place; the
 * fallback then ran a category search that by design does not check names,
 * and the caller attached the original blurb to whatever it returned. The
 * verification succeeded and the fallback silently undid it. A description
 * of a different place is worse than no description, and a substitute
 * pretending to be the recommendation is worse than an admitted substitute.
 *
 * Callers that still want something in an empty slot ask backfillActivities
 * / backfillRestaurantsForMeal for it explicitly, and get an honest generic
 * blurb and a `substitute` flag with it.
 *
 * The text search — one per item — fires for the whole batch in parallel
 * rather than one round trip at a time, but picking is done strictly in
 * `items` order, so which item "wins" a place both of them matched does not
 * depend on network timing.
 */
async function resolveNamedBatch(
  items: {
    query: string
    /**
     * The place name this item actually asked for. `query` carries the town
     * too, so it cannot be compared against a result's name directly.
     */
    expectedName: string
  }[],
  near: LatLng,
  excludeIds: Set<string>,
  apiKey: string,
  bar: QualityBar,
): Promise<(PlaceCandidate | null)[]> {
  const textResultsByIndex = await Promise.all(
    items.map((item) => textSearch(item.query, near, apiKey)),
  )

  const picks: (PlaceCandidate | null)[] = new Array(items.length).fill(null)
  for (let i = 0; i < items.length; i++) {
    const match = bestCandidate(
      textResultsByIndex[i],
      near,
      items[i].expectedName,
      excludeIds,
      bar,
    )
    if (match) {
      excludeIds.add(match.id)
      picks[i] = match
    }
  }

  return picks
}

export interface QueryPlaceFind {
  name: string
  lat: number
  lng: number
  /** ISO 3166-1 alpha-2, from the place's own address components. */
  country: string
  rating?: number
  ratingCount?: number
  summary?: string
  /** Google's own URL for the listing — see RescanFind.googleMapsUrl. */
  googleMapsUrl?: string
}

const QUERY_SEARCH_FIELD_MASK =
  'places.displayName,places.location,places.rating,places.userRatingCount,places.addressComponents,places.editorialSummary,places.formattedAddress,places.googleMapsUri'

/** Places' own bias radius cap. */
const MAX_BIAS_RADIUS_METERS = 50_000

function countryFromAddressComponents(
  components: { shortText?: string; types?: string[] }[] | undefined,
): string | undefined {
  const country = components?.find((component) =>
    component.types?.includes('country'),
  )?.shortText
  return country && country.length === 2 ? country.toUpperCase() : undefined
}

/**
 * Answers a traveler's typed description ("a cozy restaurant in Hillerød")
 * straight from Google Places, in one request.
 *
 * This exists because the "Describe it" search used to go to Claude with
 * web search for every query, which took minutes and then timed out on
 * exactly the questions Google answers instantly — reported with a
 * screenshot of the app's own failure next to Google Maps showing a dozen
 * well-rated restaurants in the same town. Anything phrased as "a <kind of
 * place> in/near <somewhere>" is a Places text search; Claude is worth its
 * latency only for the questions Places genuinely can't answer.
 *
 * Returns coordinates directly, so unlike the Claude path these finds need
 * no separate geocoding round-trip. Places whose country can't be
 * determined are dropped rather than guessed — corridorStopSchema requires
 * a real 2-letter code, and the wrong one lands the stop in the wrong
 * country's guide.
 */
export async function searchPlacesByQuery(
  query: string,
  near: LatLng,
  biasRadiusKm: number,
): Promise<QueryPlaceFind[]> {
  const apiKey = googlePlacesApiKey.value()
  if (!apiKey) {
    throw new Error(
      'GOOGLE_PLACES_API_KEY is not configured — place search requires real data and has no synthetic fallback.',
    )
  }
  const response = await fetch(
    'https://places.googleapis.com/v1/places:searchText',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': apiKey,
        'X-Goog-FieldMask': QUERY_SEARCH_FIELD_MASK,
      },
      body: JSON.stringify({
        textQuery: query,
        locationBias: {
          circle: {
            center: { latitude: near.lat, longitude: near.lng },
            radius: Math.min(biasRadiusKm * 1000, MAX_BIAS_RADIUS_METERS),
          },
        },
      }),
    },
  )
  if (!response.ok) {
    const body = await response.text().catch(() => '')
    throw new Error(
      `Places query search failed with ${response.status}: ${body.slice(0, 500)}`,
    )
  }
  const data = (await response.json()) as {
    places?: {
      displayName?: { text?: string }
      location?: { latitude: number; longitude: number }
      rating?: number
      userRatingCount?: number
      addressComponents?: { shortText?: string; types?: string[] }[]
      editorialSummary?: { text?: string }
      googleMapsUri?: string
      formattedAddress?: string
    }[]
  }
  return (data.places ?? []).flatMap((place) => {
    const name = place.displayName?.text
    const country = countryFromAddressComponents(place.addressComponents)
    if (!name || !place.location || !country) return []
    return [
      {
        name,
        lat: place.location.latitude,
        lng: place.location.longitude,
        country,
        rating: place.rating,
        ratingCount: place.userRatingCount,
        summary: place.editorialSummary?.text ?? place.formattedAddress,
        ...(place.googleMapsUri ? { googleMapsUrl: place.googleMapsUri } : {}),
      },
    ]
  })
}

/**
 * Resolves a free-text place query (e.g. "Lillehammer Camping, Lillehammer,
 * NO") to coordinates, biased near a reference point. Unlike the resolvers
 * above, this applies no quality bar — a town/campsite name isn't a "tourist
 * attraction" and may have few or no ratings; the first match is enough
 * since only its location is needed, not its quality.
 */
export async function geocodeQuery(
  query: string,
  near: LatLng,
): Promise<LatLng | null> {
  const apiKey = googlePlacesApiKey.value()
  if (!apiKey) {
    throw new Error(
      'GOOGLE_PLACES_API_KEY is not configured — geocoding requires real data and has no synthetic fallback.',
    )
  }
  const results = await textSearch(query, near, apiKey)
  const first = results[0]
  return first ? { lat: first.lat, lng: first.lng } : null
}

export interface VerifiedPlace {
  /** Places' own name for the match — see verifyPlaceLocation on why this is returned. */
  name: string
  lat: number
  lng: number
  /**
   * Google's own URL for this listing, which the search already returned
   * (FIELD_MASK asks for googleMapsUri) and which used to be discarded here.
   *
   * It is the difference between "Navigate" opening Klässbols Linneväveri and
   * opening 59°31'53.6\"N 12°44'40.7\"E — a dropped pin in a field, with no
   * name, no photos, no opening hours and no way to tell whether it is even
   * the right building. Reported with a screenshot of exactly that.
   *
   * Optional because a listing without one is possible and a stop that was
   * never verified through Places has none at all; every consumer falls back
   * to the coordinate link, which is correct if bare.
   */
  googleMapsUrl?: string
  /**
   * A URL for Google's own photo of the listing. The same shape of loss as
   * googleMapsUrl above — FIELD_MASK already asks for places.photos and
   * mapRawPlace already builds this, so every result carried one and this
   * dropped it on the floor — and the same fix.
   *
   * NOT an image this search already fetched, which an earlier version of
   * this comment claimed. What the search returns is the photo REFERENCE;
   * the bytes come from a separate Place Photo request that the browser
   * makes when an <img> with this URL is displayed, carrying the API key in
   * the query string. So every render of a card showing one is a request on
   * the project, and the consumers load it lazily for that reason.
   *
   * A curated sight is a thing the traveler is deciding whether to drive
   * hours for, and the day-by-day cards have had a photo on every activity
   * and restaurant since they existed (PlaceCard). The candidate list — the
   * screen where the deciding actually happens — had none.
   */
  photoUrl?: string
}

/**
 * Locates a place that was asked for BY NAME, and refuses to answer with
 * something else.
 *
 * geocodeQuery is deliberately unfussy — it takes the first result, because
 * a town or a campsite has one obvious answer and only its position is
 * wanted. That is exactly wrong for a named sight. `locationBias` is a
 * preference rather than a bound, so a sight that doesn't exist where it was
 * asked for is answered with a namesake somewhere else entirely: the same
 * mechanism that put a dinner stop for Helsingør at a hotel in Greece (see
 * MAX_MATCH_DISTANCE_KM). A candidate the curation phase invented, or spelled
 * in a way Places doesn't recognise, would otherwise land on the map as a
 * confident pin in the wrong country — and be routed through.
 *
 * So a result must be BOTH near the anchor and plausibly the thing that was
 * asked for (nameLooksRight), the same pair of checks isUsableMatch applies
 * to a plan's activities. No quality bar: a small trailhead or a village
 * church may have almost no ratings and still be exactly right, and unlike
 * the activity path there is no backfill here that a low-rated match would
 * be crowding out.
 *
 * Returns Places' own spelling of the name, which is worth more than it
 * looks: it collapses the model's variations ("Kronborg", "Kronborg Slot",
 * "Kronborg Castle") onto one stable identity, which is what lets a repeated
 * curation pass recognise a sight it has already proposed instead of adding
 * it again.
 *
 * Ordering is `bestCandidate`'s, which is the point of routing through it
 * rather than keeping a second copy of the checks: this used to take Places'
 * first passing result, and Places orders by prominence, so a well-known
 * near-namesake ("Kronborg Bageri") outranked the sight itself. Identity
 * decides here, and with NO_QUALITY_BAR admitting everything, nothing else
 * can override it.
 */
export async function verifyPlaceLocation(
  query: string,
  expectedName: string,
  near: LatLng,
  maxDistanceKm: number = MAX_MATCH_DISTANCE_KM,
): Promise<VerifiedPlace | null> {
  const apiKey = googlePlacesApiKey.value()
  if (!apiKey) {
    throw new Error(
      'GOOGLE_PLACES_API_KEY is not configured — place verification requires real data and has no synthetic fallback.',
    )
  }
  const results = await textSearch(query, near, apiKey)
  const match = bestCandidate(
    results,
    near,
    expectedName,
    new Set<string>(),
    NO_QUALITY_BAR,
    maxDistanceKm,
  )
  return match
    ? {
        name: match.name,
        lat: match.lat,
        lng: match.lng,
        ...(match.googleMapsUrl ? { googleMapsUrl: match.googleMapsUrl } : {}),
        ...(match.photoUrl ? { photoUrl: match.photoUrl } : {}),
      }
    : null
}

export interface ProposedActivity {
  name: string
  town: string
  category: ActivityCategory
  kidFriendly: boolean
  blurb: string
}

/**
 * Resolves `count` top-rated activities via Places, rotating through every
 * category so a single exhausted category can't stall the whole backfill.
 * Shared by enrichActivities's own backfill (filling up to the displayed
 * count) and researchMoreAlternativesCallable.ts (topping the pool back up
 * once both the displayed items and their reserve are gone) — same logic,
 * different caller, not a hand-rolled second copy.
 *
 * Everything this produces is flagged `substitute` and given a generic
 * blurb. Nobody chose these places for this trip; they are the best-rated
 * things of their kind nearby, and the traveler is entitled to know which of
 * the two a card is (see PlaceCard's "Top-rated nearby" chip). Never inherit
 * a proposal's blurb here — that is how a shopping centre ended up described
 * as "Charming lakeside café near the castle".
 */
export async function backfillActivities(
  near: LatLng,
  excludeIds: Set<string>,
  apiKey: string,
  count: number,
  reserve: boolean,
): Promise<Activity[]> {
  const categories = Object.keys(ACTIVITY_PLACE_TYPE) as ActivityCategory[]
  const resolved: Activity[] = []
  // One pool per category, fetched at most once however many slots that
  // category ends up filling — see categoryPool.
  const pools = new Map<ActivityCategory, PlaceCandidate[]>()
  for (
    let attempt = 0;
    resolved.length < count && attempt < MAX_BACKFILL_ATTEMPTS;
    attempt++
  ) {
    const category = categories[attempt % categories.length]
    let pool = pools.get(category)
    if (!pool) {
      pool = await categoryPool(
        category,
        ACTIVITY_PLACE_TYPE[category],
        near,
        apiKey,
      )
      pools.set(category, pool)
    }
    const match = bestFromLadder(pool, near, excludeIds, PLACE_QUALITY_LADDER)
    if (match) {
      excludeIds.add(match.id)
      resolved.push({
        name: match.name,
        category,
        lat: match.lat,
        lng: match.lng,
        rating: match.rating,
        ratingCount: match.ratingCount,
        googleMapsUrl: match.googleMapsUrl,
        photoUrl: match.photoUrl,
        openingHours: match.openingHours,
        // Google's own description of THIS place when it has one, and the
        // template only when it does not. Never a proposal's blurb — that is
        // how a shopping centre came to be described as "Charming lakeside
        // café near the castle" — but Google's summary is about the very
        // place being shown, so it carries no such risk, and it is the
        // difference between a card that reads like a suggestion and one
        // that reads like a filler.
        blurb: match.editorialSummary ?? `A well-rated local ${category}.`,
        kidFriendly: false,
        status: 'suggested',
        substitute: true,
        ...(reserve ? { reserve: true } : {}),
        placeId: match.id,
      })
    }
  }
  return resolved
}

/**
 * Resolves proposed activities against Places, backfilling by category until
 * exactly `ACTIVITIES_PER_DAY` are found, then resolves `RESERVE_ACTIVITY_COUNT`
 * more on top — invisible until dismiss-and-requeue needs one (see
 * activitySchema's own comment).
 *
 * A proposal that Places cannot verify does not degrade into a nearby place
 * wearing its description: it drops out entirely, and the slot is refilled
 * from the quality ladder as an admitted substitute.
 */
export async function enrichActivities(
  proposed: ProposedActivity[],
  near: LatLng,
): Promise<Activity[]> {
  const apiKey = googlePlacesApiKey.value()
  if (!apiKey) {
    throw new Error(
      'GOOGLE_PLACES_API_KEY is not configured — Places enrichment requires real data and has no synthetic fallback.',
    )
  }

  const excludeIds = new Set<string>()
  const resolved: Activity[] = []

  const matches = await resolveNamedBatch(
    proposed.map((item) => ({
      query: `${item.name}, ${item.town}`,
      // What was actually asked for, so a famous unrelated landmark cannot
      // answer for a small named place — see nameLooksRight.
      expectedName: item.name,
    })),
    near,
    excludeIds,
    apiKey,
    PLACE_VERIFY_BAR,
  )
  for (let i = 0; i < proposed.length; i++) {
    const match = matches[i]
    const item = proposed[i]
    if (match) {
      resolved.push({
        name: match.name,
        category: item.category,
        lat: match.lat,
        lng: match.lng,
        rating: match.rating,
        ratingCount: match.ratingCount,
        googleMapsUrl: match.googleMapsUrl,
        photoUrl: match.photoUrl,
        openingHours: match.openingHours,
        blurb: item.blurb,
        kidFriendly: item.kidFriendly,
        status: 'suggested',
        placeId: match.id,
      })
    }
  }

  // What was proposed for this day and could not be confirmed to exist where
  // it was said to be. Logged because it was invisible: a dropped proposal is
  // not shown as a gap, it is quietly replaced by the best-rated thing of its
  // kind nearby, so nothing on the day and nothing in the logs said how much
  // of it was the planner's judgement and how much was a fallback. Reported
  // as "the descriptions for activities seem to have become quite generic",
  // which is exactly what a run of substitutes looks like from outside. One
  // line per day, naming them, so the rate is a number rather than a hunch.
  const dropped = proposed
    .filter((_, i) => !matches[i])
    .map((item) => `${item.name} (${item.town})`)
  if (dropped.length > 0) {
    console.info(
      `Activities: ${dropped.length} of ${proposed.length} proposed could not be verified and were replaced from top-rated nearby — ${dropped.join('; ')}`,
    )
  }

  resolved.push(
    ...(await backfillActivities(
      near,
      excludeIds,
      apiKey,
      ACTIVITIES_PER_DAY - resolved.length,
      false,
    )),
  )
  const primary = resolved.slice(0, ACTIVITIES_PER_DAY)
  const reserve = await backfillActivities(
    near,
    excludeIds,
    apiKey,
    RESERVE_ACTIVITY_COUNT,
    true,
  )
  return [...primary, ...reserve]
}

export interface ProposedRestaurant {
  name: string
  town: string
  meal: Meal
  cuisine?: string
  blurb: string
}

/**
 * Resolves `count` top-rated restaurants for one meal via Places. Shared by
 * enrichRestaurantsForMeal's own backfill and researchMoreAlternativesCallable.ts
 * — see backfillActivities's own comment for why this isn't duplicated, and
 * for why everything here is flagged `substitute` with a generic blurb.
 *
 * One pool, ranked, rather than one search per slot: every slot here asks
 * Places the identical question ("restaurants near this point"), so the old
 * loop paid for the same list up to eight times and skimmed one more result
 * off the top of it each time — which is to say it filled a meal with the
 * three most PROMINENT places, not the three best.
 */
export async function backfillRestaurantsForMeal(
  meal: Meal,
  near: LatLng,
  excludeIds: Set<string>,
  apiKey: string,
  count: number,
  reserve: boolean,
): Promise<Restaurant[]> {
  if (count <= 0) return []
  const pool = await categoryPool(
    MEAL_PLACE_TYPE[meal],
    MEAL_PLACE_TYPE[meal],
    near,
    apiKey,
  )
  const resolved: Restaurant[] = []
  while (resolved.length < count) {
    const match = bestFromLadder(
      pool,
      near,
      excludeIds,
      RESTAURANT_QUALITY_LADDER,
    )
    if (!match) break
    excludeIds.add(match.id)
    resolved.push({
      name: match.name,
      meal,
      lat: match.lat,
      lng: match.lng,
      rating: match.rating,
      ratingCount: match.ratingCount,
      googleMapsUrl: match.googleMapsUrl,
      photoUrl: match.photoUrl,
      priceLevel: match.priceLevel,
      // Google's own line about this very place when it has one — see the
      // matching note in backfillActivities.
      blurb: match.editorialSummary ?? `A well-rated spot for ${meal}.`,
      status: 'suggested',
      substitute: true,
      ...(reserve ? { reserve: true } : {}),
      placeId: match.id,
    })
  }
  return resolved
}

/**
 * Resolves proposed restaurants for one meal, backfilling until exactly
 * `RESTAURANTS_PER_MEAL` are found, then resolves
 * `RESERVE_RESTAURANTS_PER_MEAL` more on top — same reserve mechanism as
 * enrichActivities, and the same rule about unverifiable proposals: they
 * drop rather than lend their description to a stand-in.
 */
export async function enrichRestaurantsForMeal(
  proposed: ProposedRestaurant[],
  meal: Meal,
  near: LatLng,
  excludeIds: Set<string>,
): Promise<Restaurant[]> {
  const apiKey = googlePlacesApiKey.value()
  if (!apiKey) {
    throw new Error(
      'GOOGLE_PLACES_API_KEY is not configured — Places enrichment requires real data and has no synthetic fallback.',
    )
  }

  const resolved: Restaurant[] = []

  const matches = await resolveNamedBatch(
    proposed.map((item) => ({
      query: `${item.name}, ${item.town}`,
      // What was actually asked for, so a famous unrelated landmark cannot
      // answer for a small named place — see nameLooksRight.
      expectedName: item.name,
    })),
    near,
    excludeIds,
    apiKey,
    RESTAURANT_VERIFY_BAR,
  )
  for (let i = 0; i < proposed.length; i++) {
    const match = matches[i]
    const item = proposed[i]
    if (match) {
      resolved.push({
        name: match.name,
        meal,
        lat: match.lat,
        lng: match.lng,
        rating: match.rating,
        ratingCount: match.ratingCount,
        googleMapsUrl: match.googleMapsUrl,
        photoUrl: match.photoUrl,
        priceLevel: match.priceLevel,
        cuisine: item.cuisine,
        blurb: item.blurb,
        status: 'suggested',
        placeId: match.id,
      })
    }
  }

  // Same record as the activities above, per meal.
  const droppedMeals = proposed
    .filter((_, i) => !matches[i])
    .map((item) => `${item.name} (${item.town})`)
  if (droppedMeals.length > 0) {
    console.info(
      `Restaurants (${meal}): ${droppedMeals.length} of ${proposed.length} proposed could not be verified and were replaced from top-rated nearby — ${droppedMeals.join('; ')}`,
    )
  }

  resolved.push(
    ...(await backfillRestaurantsForMeal(
      meal,
      near,
      excludeIds,
      apiKey,
      RESTAURANTS_PER_MEAL - resolved.length,
      false,
    )),
  )
  const primary = resolved.slice(0, RESTAURANTS_PER_MEAL)
  const reserve = await backfillRestaurantsForMeal(
    meal,
    near,
    excludeIds,
    apiKey,
    RESERVE_RESTAURANTS_PER_MEAL,
    true,
  )
  return [...primary, ...reserve]
}

/**
 * How far from a town a campsite may be and still count as that town's
 * overnight stop. nearbySearch's own locationRestriction already caps
 * results at SEARCH_RADIUS_METERS, so this only tightens it: 30km out is a
 * different place to spend the evening, not "the edge of town".
 */
const OVERNIGHT_CAMPSITE_MAX_KM = 20

/**
 * The nearest campsite to a town — where an RV would actually spend the
 * night there.
 *
 * Added 2026-08-12. A generated overnight stop was geocoded straight from
 * "Berlin, Berlin, DE", and a text search for a city answers with the city:
 * the plan's overnight for that night was 52.52,13.405, which is an
 * intersection in Mitte. Every downstream use of that point — the Day View
 * pin, its "Navigate" link, the overview map marker — pointed at a road
 * junction you cannot park an RV on, let alone sleep at.
 *
 * Nearest rather than best-rated: this is the default the traveler gets
 * before they have opinions, and "just outside the town I picked" is the
 * property that makes a default defensible. If they want a different one,
 * "Change overnight" offers the full ranked set (campsites, stellplatz,
 * wild) from getOvernightCandidates.
 *
 * Falls back to the nearest campsite of any quality before returning null:
 * a site with four reviews is still somewhere to sleep, and the alternative
 * this is rescuing the plan from is a road junction.
 */
export async function findNearbyCampsites(
  near: LatLng,
  country: string,
  limit: number,
): Promise<OvernightStopCandidate[]> {
  const apiKey = googlePlacesApiKey.value()
  if (!apiKey) {
    throw new Error(
      'GOOGLE_PLACES_API_KEY is not configured — campsite lookup requires real data and has no synthetic fallback.',
    )
  }

  const found: PlaceCandidate[] = []
  for (const placeType of ['rv_park', 'campground']) {
    found.push(...(await nearbySearch(placeType, near, apiKey)))
  }

  const seen = new Set<string>()
  const byDistance = found
    .filter((candidate) => {
      if (seen.has(candidate.id)) return false
      seen.add(candidate.id)
      return true
    })
    .map((candidate) => ({
      candidate,
      km: haversineDistanceKm(near, {
        lat: candidate.lat,
        lng: candidate.lng,
      }),
    }))
    .filter((entry) => entry.km <= OVERNIGHT_CAMPSITE_MAX_KM)
    // Quality first, then distance: unlike stellplatz and free parking,
    // commercial campsites carry ratings, and a well-reviewed site 15km out
    // beats an unrated one at 4km for somewhere you are paying to sleep.
    // Deliberately the verification bar rather than the quality ladder the
    // activity/restaurant fills use: this is a two-way sort that keeps
    // everything it finds, so it wants the modest "not a dud" line, and the
    // property that makes the default defensible is still nearness.
    .sort(
      (a, b) =>
        Number(meetsQualityBar(b.candidate, PLACE_VERIFY_BAR)) -
          Number(meetsQualityBar(a.candidate, PLACE_VERIFY_BAR)) || a.km - b.km,
    )

  return byDistance.slice(0, limit).map(({ candidate }) => ({
    name: candidate.name,
    type: 'campsite' as const,
    lat: candidate.lat,
    lng: candidate.lng,
    country,
    description: candidate.rating
      ? `Rated ${candidate.rating.toFixed(1)} (${candidate.ratingCount ?? 0} reviews) on Google.`
      : 'Commercial campsite.',
    source: 'places' as const,
    ...(candidate.googleMapsUrl ? { googleMapsUrl: candidate.googleMapsUrl } : {}),
  }))
}

