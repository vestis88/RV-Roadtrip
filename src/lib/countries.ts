import { isoCountryFlag } from './countryFlag'

export interface Country {
  code: string
  name: string
}

/**
 * Every country a trip can prefer, as ISO 3166-1 alpha-2 codes.
 *
 * The code is the ONLY thing that ever gets stored: tripSettingsSchema's
 * `preferredCountries: z.array(z.string().length(2))` rejects anything else,
 * and a rejected settings write doesn't fail loudly on the client — it fails
 * on the next read/validation of the trip document, i.e. the trip stops
 * working. So the picker is deliberately built as a *closed* vocabulary
 * (search this list, store its code) rather than the free-text entry the
 * interests chips use: there is no path here where a traveler's own typing
 * reaches Firestore.
 *
 * Generated from CLDR's region display names (the same data Intl.DisplayNames
 * serves) filtered down to the 249 codes ISO 3166-1 currently assigns —
 * withdrawn codes (SU, YU, AN…), exceptional reservations (UK, EU, AC…),
 * groupings and test values are all excluded, so every entry is a code the
 * flag renderer and Claude both understand. Held as a literal rather than
 * read from Intl at runtime because the names have to be stable: ICU data
 * differs between browsers and Node versions, and a list whose labels shift
 * under it can't be searched or tested deterministically.
 */
export const ALL_COUNTRIES: Country[] = [
  { code: 'AD', name: 'Andorra' },
  { code: 'AE', name: 'United Arab Emirates' },
  { code: 'AF', name: 'Afghanistan' },
  { code: 'AG', name: 'Antigua & Barbuda' },
  { code: 'AI', name: 'Anguilla' },
  { code: 'AL', name: 'Albania' },
  { code: 'AM', name: 'Armenia' },
  { code: 'AO', name: 'Angola' },
  { code: 'AQ', name: 'Antarctica' },
  { code: 'AR', name: 'Argentina' },
  { code: 'AS', name: 'American Samoa' },
  { code: 'AT', name: 'Austria' },
  { code: 'AU', name: 'Australia' },
  { code: 'AW', name: 'Aruba' },
  { code: 'AX', name: 'Åland Islands' },
  { code: 'AZ', name: 'Azerbaijan' },
  { code: 'BA', name: 'Bosnia & Herzegovina' },
  { code: 'BB', name: 'Barbados' },
  { code: 'BD', name: 'Bangladesh' },
  { code: 'BE', name: 'Belgium' },
  { code: 'BF', name: 'Burkina Faso' },
  { code: 'BG', name: 'Bulgaria' },
  { code: 'BH', name: 'Bahrain' },
  { code: 'BI', name: 'Burundi' },
  { code: 'BJ', name: 'Benin' },
  { code: 'BL', name: 'St. Barthélemy' },
  { code: 'BM', name: 'Bermuda' },
  { code: 'BN', name: 'Brunei' },
  { code: 'BO', name: 'Bolivia' },
  { code: 'BQ', name: 'Caribbean Netherlands' },
  { code: 'BR', name: 'Brazil' },
  { code: 'BS', name: 'Bahamas' },
  { code: 'BT', name: 'Bhutan' },
  { code: 'BV', name: 'Bouvet Island' },
  { code: 'BW', name: 'Botswana' },
  { code: 'BY', name: 'Belarus' },
  { code: 'BZ', name: 'Belize' },
  { code: 'CA', name: 'Canada' },
  { code: 'CC', name: 'Cocos (Keeling) Islands' },
  { code: 'CD', name: 'Congo (Kinshasa)' },
  { code: 'CF', name: 'Central African Republic' },
  { code: 'CG', name: 'Congo (Brazzaville)' },
  { code: 'CH', name: 'Switzerland' },
  { code: 'CI', name: 'Côte d’Ivoire' },
  { code: 'CK', name: 'Cook Islands' },
  { code: 'CL', name: 'Chile' },
  { code: 'CM', name: 'Cameroon' },
  { code: 'CN', name: 'China' },
  { code: 'CO', name: 'Colombia' },
  { code: 'CR', name: 'Costa Rica' },
  { code: 'CU', name: 'Cuba' },
  { code: 'CV', name: 'Cape Verde' },
  { code: 'CW', name: 'Curaçao' },
  { code: 'CX', name: 'Christmas Island' },
  { code: 'CY', name: 'Cyprus' },
  { code: 'CZ', name: 'Czechia' },
  { code: 'DE', name: 'Germany' },
  { code: 'DJ', name: 'Djibouti' },
  { code: 'DK', name: 'Denmark' },
  { code: 'DM', name: 'Dominica' },
  { code: 'DO', name: 'Dominican Republic' },
  { code: 'DZ', name: 'Algeria' },
  { code: 'EC', name: 'Ecuador' },
  { code: 'EE', name: 'Estonia' },
  { code: 'EG', name: 'Egypt' },
  { code: 'EH', name: 'Western Sahara' },
  { code: 'ER', name: 'Eritrea' },
  { code: 'ES', name: 'Spain' },
  { code: 'ET', name: 'Ethiopia' },
  { code: 'FI', name: 'Finland' },
  { code: 'FJ', name: 'Fiji' },
  { code: 'FK', name: 'Falkland Islands' },
  { code: 'FM', name: 'Micronesia' },
  { code: 'FO', name: 'Faroe Islands' },
  { code: 'FR', name: 'France' },
  { code: 'GA', name: 'Gabon' },
  { code: 'GB', name: 'United Kingdom' },
  { code: 'GD', name: 'Grenada' },
  { code: 'GE', name: 'Georgia' },
  { code: 'GF', name: 'French Guiana' },
  { code: 'GG', name: 'Guernsey' },
  { code: 'GH', name: 'Ghana' },
  { code: 'GI', name: 'Gibraltar' },
  { code: 'GL', name: 'Greenland' },
  { code: 'GM', name: 'Gambia' },
  { code: 'GN', name: 'Guinea' },
  { code: 'GP', name: 'Guadeloupe' },
  { code: 'GQ', name: 'Equatorial Guinea' },
  { code: 'GR', name: 'Greece' },
  { code: 'GS', name: 'South Georgia & South Sandwich Islands' },
  { code: 'GT', name: 'Guatemala' },
  { code: 'GU', name: 'Guam' },
  { code: 'GW', name: 'Guinea-Bissau' },
  { code: 'GY', name: 'Guyana' },
  { code: 'HK', name: 'Hong Kong SAR China' },
  { code: 'HM', name: 'Heard & McDonald Islands' },
  { code: 'HN', name: 'Honduras' },
  { code: 'HR', name: 'Croatia' },
  { code: 'HT', name: 'Haiti' },
  { code: 'HU', name: 'Hungary' },
  { code: 'ID', name: 'Indonesia' },
  { code: 'IE', name: 'Ireland' },
  { code: 'IL', name: 'Israel' },
  { code: 'IM', name: 'Isle of Man' },
  { code: 'IN', name: 'India' },
  { code: 'IO', name: 'British Indian Ocean Territory' },
  { code: 'IQ', name: 'Iraq' },
  { code: 'IR', name: 'Iran' },
  { code: 'IS', name: 'Iceland' },
  { code: 'IT', name: 'Italy' },
  { code: 'JE', name: 'Jersey' },
  { code: 'JM', name: 'Jamaica' },
  { code: 'JO', name: 'Jordan' },
  { code: 'JP', name: 'Japan' },
  { code: 'KE', name: 'Kenya' },
  { code: 'KG', name: 'Kyrgyzstan' },
  { code: 'KH', name: 'Cambodia' },
  { code: 'KI', name: 'Kiribati' },
  { code: 'KM', name: 'Comoros' },
  { code: 'KN', name: 'St. Kitts & Nevis' },
  { code: 'KP', name: 'North Korea' },
  { code: 'KR', name: 'South Korea' },
  { code: 'KW', name: 'Kuwait' },
  { code: 'KY', name: 'Cayman Islands' },
  { code: 'KZ', name: 'Kazakhstan' },
  { code: 'LA', name: 'Laos' },
  { code: 'LB', name: 'Lebanon' },
  { code: 'LC', name: 'St. Lucia' },
  { code: 'LI', name: 'Liechtenstein' },
  { code: 'LK', name: 'Sri Lanka' },
  { code: 'LR', name: 'Liberia' },
  { code: 'LS', name: 'Lesotho' },
  { code: 'LT', name: 'Lithuania' },
  { code: 'LU', name: 'Luxembourg' },
  { code: 'LV', name: 'Latvia' },
  { code: 'LY', name: 'Libya' },
  { code: 'MA', name: 'Morocco' },
  { code: 'MC', name: 'Monaco' },
  { code: 'MD', name: 'Moldova' },
  { code: 'ME', name: 'Montenegro' },
  { code: 'MF', name: 'St. Martin' },
  { code: 'MG', name: 'Madagascar' },
  { code: 'MH', name: 'Marshall Islands' },
  { code: 'MK', name: 'North Macedonia' },
  { code: 'ML', name: 'Mali' },
  { code: 'MM', name: 'Myanmar (Burma)' },
  { code: 'MN', name: 'Mongolia' },
  { code: 'MO', name: 'Macao SAR China' },
  { code: 'MP', name: 'Northern Mariana Islands' },
  { code: 'MQ', name: 'Martinique' },
  { code: 'MR', name: 'Mauritania' },
  { code: 'MS', name: 'Montserrat' },
  { code: 'MT', name: 'Malta' },
  { code: 'MU', name: 'Mauritius' },
  { code: 'MV', name: 'Maldives' },
  { code: 'MW', name: 'Malawi' },
  { code: 'MX', name: 'Mexico' },
  { code: 'MY', name: 'Malaysia' },
  { code: 'MZ', name: 'Mozambique' },
  { code: 'NA', name: 'Namibia' },
  { code: 'NC', name: 'New Caledonia' },
  { code: 'NE', name: 'Niger' },
  { code: 'NF', name: 'Norfolk Island' },
  { code: 'NG', name: 'Nigeria' },
  { code: 'NI', name: 'Nicaragua' },
  { code: 'NL', name: 'Netherlands' },
  { code: 'NO', name: 'Norway' },
  { code: 'NP', name: 'Nepal' },
  { code: 'NR', name: 'Nauru' },
  { code: 'NU', name: 'Niue' },
  { code: 'NZ', name: 'New Zealand' },
  { code: 'OM', name: 'Oman' },
  { code: 'PA', name: 'Panama' },
  { code: 'PE', name: 'Peru' },
  { code: 'PF', name: 'French Polynesia' },
  { code: 'PG', name: 'Papua New Guinea' },
  { code: 'PH', name: 'Philippines' },
  { code: 'PK', name: 'Pakistan' },
  { code: 'PL', name: 'Poland' },
  { code: 'PM', name: 'St. Pierre & Miquelon' },
  { code: 'PN', name: 'Pitcairn Islands' },
  { code: 'PR', name: 'Puerto Rico' },
  { code: 'PS', name: 'Palestinian Territories' },
  { code: 'PT', name: 'Portugal' },
  { code: 'PW', name: 'Palau' },
  { code: 'PY', name: 'Paraguay' },
  { code: 'QA', name: 'Qatar' },
  { code: 'RE', name: 'Réunion' },
  { code: 'RO', name: 'Romania' },
  { code: 'RS', name: 'Serbia' },
  { code: 'RU', name: 'Russia' },
  { code: 'RW', name: 'Rwanda' },
  { code: 'SA', name: 'Saudi Arabia' },
  { code: 'SB', name: 'Solomon Islands' },
  { code: 'SC', name: 'Seychelles' },
  { code: 'SD', name: 'Sudan' },
  { code: 'SE', name: 'Sweden' },
  { code: 'SG', name: 'Singapore' },
  { code: 'SH', name: 'St. Helena' },
  { code: 'SI', name: 'Slovenia' },
  { code: 'SJ', name: 'Svalbard & Jan Mayen' },
  { code: 'SK', name: 'Slovakia' },
  { code: 'SL', name: 'Sierra Leone' },
  { code: 'SM', name: 'San Marino' },
  { code: 'SN', name: 'Senegal' },
  { code: 'SO', name: 'Somalia' },
  { code: 'SR', name: 'Suriname' },
  { code: 'SS', name: 'South Sudan' },
  { code: 'ST', name: 'São Tomé & Príncipe' },
  { code: 'SV', name: 'El Salvador' },
  { code: 'SX', name: 'Sint Maarten' },
  { code: 'SY', name: 'Syria' },
  { code: 'SZ', name: 'Eswatini' },
  { code: 'TC', name: 'Turks & Caicos Islands' },
  { code: 'TD', name: 'Chad' },
  { code: 'TF', name: 'French Southern Territories' },
  { code: 'TG', name: 'Togo' },
  { code: 'TH', name: 'Thailand' },
  { code: 'TJ', name: 'Tajikistan' },
  { code: 'TK', name: 'Tokelau' },
  { code: 'TL', name: 'Timor-Leste' },
  { code: 'TM', name: 'Turkmenistan' },
  { code: 'TN', name: 'Tunisia' },
  { code: 'TO', name: 'Tonga' },
  { code: 'TR', name: 'Türkiye' },
  { code: 'TT', name: 'Trinidad & Tobago' },
  { code: 'TV', name: 'Tuvalu' },
  { code: 'TW', name: 'Taiwan' },
  { code: 'TZ', name: 'Tanzania' },
  { code: 'UA', name: 'Ukraine' },
  { code: 'UG', name: 'Uganda' },
  { code: 'UM', name: 'U.S. Outlying Islands' },
  { code: 'US', name: 'United States' },
  { code: 'UY', name: 'Uruguay' },
  { code: 'UZ', name: 'Uzbekistan' },
  { code: 'VA', name: 'Vatican City' },
  { code: 'VC', name: 'St. Vincent & Grenadines' },
  { code: 'VE', name: 'Venezuela' },
  { code: 'VG', name: 'British Virgin Islands' },
  { code: 'VI', name: 'U.S. Virgin Islands' },
  { code: 'VN', name: 'Vietnam' },
  { code: 'VU', name: 'Vanuatu' },
  { code: 'WF', name: 'Wallis & Futuna' },
  { code: 'WS', name: 'Samoa' },
  // Not assigned by ISO 3166-1 — XK is the user-assigned code the EU,
  // Google and CLDR all settled on for Kosovo, and this is a European
  // road-trip planner where "drive Croatia to Albania" is a real itinerary
  // that passes through it. Two letters, so it satisfies the schema, and
  // both the flag renderer and Claude read it as Kosovo.
  { code: 'XK', name: 'Kosovo' },
  { code: 'YE', name: 'Yemen' },
  { code: 'YT', name: 'Mayotte' },
  { code: 'ZA', name: 'South Africa' },
  { code: 'ZM', name: 'Zambia' },
  { code: 'ZW', name: 'Zimbabwe' },
]

const COUNTRY_NAMES: ReadonlyMap<string, string> = new Map(
  ALL_COUNTRIES.map((country) => [country.code, country.name]),
)

/**
 * The countries offered as one-tap chips, roughly north-to-south along the
 * corridors this app was built for. They are the common case and stay
 * instantly tappable — the search box exists for everything else, not to
 * replace these.
 *
 * Only codes are listed: taking the names from ALL_COUNTRIES keeps a chip
 * from drifting out of step with the same country's label everywhere else
 * (this list said "Czech Republic" long after the picker would have said
 * "Czechia", and a chip labelled differently from the Countries tab reads
 * as two different places).
 */
const QUICK_PICK_CODES = [
  'NO',
  'SE',
  'DK',
  'DE',
  'NL',
  'BE',
  'FR',
  'CH',
  'AT',
  'IT',
  'SI',
  'HR',
  'ES',
  'PT',
  'PL',
  'CZ',
]

export const EUROPEAN_COUNTRIES: Country[] = QUICK_PICK_CODES.map((code) => ({
  code,
  name: COUNTRY_NAMES.get(code) ?? code,
}))

const QUICK_PICK_SET = new Set(QUICK_PICK_CODES)

/**
 * Names a traveler is likely to type that aren't a substring of the CLDR
 * name, so plain matching would return nothing at all for a country that is
 * very much in the list.
 *
 * "Luxemburg" is the case this whole feature came from — the trip in the
 * bug report was *named* that (it's the German/Dutch/Nordic spelling and a
 * common English slip), so it's exactly what its owner would type. The rest
 * are renames the world hasn't finished adopting (Türkiye, Czechia,
 * Eswatini), endonyms that replaced a familiar name (Côte d'Ivoire), and
 * the constituent countries of the UK, which have no code of their own.
 */
const COUNTRY_ALIASES: Record<string, string[]> = {
  AE: ['UAE', 'Emirates'],
  BA: ['Bosnia', 'Herzegovina'],
  CI: ['Ivory Coast'],
  CV: ['Cabo Verde'],
  CZ: ['Czech Republic'],
  GB: [
    'UK',
    'Great Britain',
    'Britain',
    'England',
    'Scotland',
    'Wales',
    'Northern Ireland',
  ],
  IE: ['Republic of Ireland', 'Eire'],
  LU: ['Luxemburg'],
  MM: ['Burma'],
  NL: ['Holland'],
  RU: ['Russian Federation'],
  SZ: ['Swaziland'],
  TL: ['East Timor'],
  TR: ['Turkey'],
  US: ['USA', 'America', 'United States of America'],
  VA: ['Holy See', 'Vatican'],
  XK: ['Kosova'],
}

/**
 * The name to show for a stored code. Falls back to the code itself, which
 * is what a country the list somehow doesn't know still has to render as —
 * previously EVERY country outside the 16 quick picks fell into that branch,
 * so a plan that overnighted in Luxembourg listed "LU" on the Countries tab
 * and, worse, asked Claude to research a country called "LU" (the country
 * guide callable is handed this name, not the code — see
 * CountryDetailScreen).
 */
export function countryName(code: string): string {
  return COUNTRY_NAMES.get(code.toUpperCase()) ?? code
}

/** Flag + name, the label form used on chips and in search results alike —
 * the flag is also the traveler's confirmation that the code resolved to the
 * country they meant. */
export function countryLabel(code: string): string {
  const flag = isoCountryFlag(code)
  return flag ? `${flag} ${countryName(code)}` : countryName(code)
}

/**
 * The chips to render for the "Preferred countries" list: the quick picks,
 * plus any already-selected country that isn't one of them, appended in the
 * order it was chosen.
 *
 * Appending rather than sorting keeps a just-added country at the end where
 * the traveler's eye already is (right above the search box they used), and
 * keeps the quick picks in their familiar positions instead of reshuffling
 * the whole row every time something is added. Without this, a selected
 * country outside the presets fell through to ChipMultiSelect's raw-value
 * label and rendered as a bare "LU".
 *
 * Derived entirely from what's selected, so deselecting an added country
 * removes its chip rather than leaving a row that grows all session with
 * countries the traveler has ruled out. Re-adding it is the same three
 * keystrokes it was the first time.
 */
export function countryChipOptions(
  selected: readonly string[],
): { value: string; label: string }[] {
  const extras = selected.filter((code) => !QUICK_PICK_SET.has(code))
  return [...QUICK_PICK_CODES, ...extras].map((code) => ({
    value: code,
    label: countryLabel(code),
  }))
}

/** Lowercases, strips accents, and reduces punctuation to single spaces, so
 * "cote d'ivoire", "Côte d’Ivoire" and "COTE  D IVOIRE" all compare equal. */
function normalize(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

/** True when every character of `query` appears in `text` in order — the
 * loosest tier of matching, which is what rescues near-misses like
 * "luxemburg" against "luxembourg" or "portugual" against "portugal". */
function isSubsequence(query: string, text: string): boolean {
  let i = 0
  for (const char of text) {
    if (char === query[i]) i += 1
    if (i === query.length) return true
  }
  return false
}

// Lower is better. Kept as explicit tiers rather than a single fuzzy score
// so the ordering is something a test can state in words: an exact code
// beats a name that starts with what you typed, which beats a name that
// merely contains it, which beats a spelling that only nearly matches.
const RANK_CODE = 0
const RANK_PREFIX = 1
const RANK_WORD = 2
const RANK_SUBSTRING = 3
const RANK_FUZZY = 4
const RANK_NONE = 99

// An alias match is a real match, but a country whose actual name matches
// the same way should still come first — "north" is North Macedonia asking
// for itself, not the UK by way of "Northern Ireland".
const ALIAS_PENALTY = 0.5

/**
 * Every searchable spelling, normalized once at module load rather than on
 * each keystroke: this runs on every character typed, over 250 countries, on
 * a phone, and NFD-normalizing a few hundred strings per keypress is the
 * kind of work that turns a picker sluggish for no reason.
 */
const SEARCH_INDEX = ALL_COUNTRIES.map((country) => ({
  country,
  code: country.code.toLowerCase(),
  // The country's own name first — `rank` leans on that ordering to keep an
  // alias from outranking a real name.
  names: [country.name, ...(COUNTRY_ALIASES[country.code] ?? [])].map(
    normalize,
  ),
}))

type SearchEntry = (typeof SEARCH_INDEX)[number]

function rank(entry: SearchEntry, query: string, squashed: string): number {
  if (query.length === 2 && entry.code === query) {
    return RANK_CODE
  }
  let best = RANK_NONE
  entry.names.forEach((normalized, index) => {
    const penalty = index === 0 ? 0 : ALIAS_PENALTY
    let tier = RANK_NONE
    if (normalized.startsWith(query)) tier = RANK_PREFIX
    else if (normalized.includes(` ${query}`)) tier = RANK_WORD
    else if (normalized.includes(query)) tier = RANK_SUBSTRING
    else if (
      // Only for queries long enough to be a real attempt at a name;
      // two or three characters are a subsequence of half the world.
      squashed.length >= 4 &&
      isSubsequence(squashed, normalized.replace(/ /g, ''))
    ) {
      tier = RANK_FUZZY
    }
    if (tier !== RANK_NONE) best = Math.min(best, tier + penalty)
  })
  return best
}

/**
 * Ranked country matches for what the traveler has typed so far.
 *
 * Deliberately not a dropdown of all 250: on a phone, in an RV, scrolling a
 * list that long to find one country is worse than typing three letters, and
 * a select that long would also bury the quick-pick chips it sits under.
 * Ties break toward the quick-pick countries (this is a European trip
 * planner, so "Sw" should reach Switzerland and Sweden before Swaziland)
 * and then alphabetically, so the same query always produces the same order.
 */
export function searchCountries(query: string, limit = 6): Country[] {
  const normalized = normalize(query)
  if (!normalized) return []
  const squashed = normalized.replace(/ /g, '')
  return SEARCH_INDEX.map((entry) => ({
    country: entry.country,
    score: rank(entry, normalized, squashed),
  }))
    .filter((scored) => scored.score !== RANK_NONE)
    .sort((a, b) => {
      if (a.score !== b.score) return a.score - b.score
      const aQuick = QUICK_PICK_SET.has(a.country.code)
      const bQuick = QUICK_PICK_SET.has(b.country.code)
      if (aQuick !== bQuick) return aQuick ? -1 : 1
      return a.country.name.localeCompare(b.country.name)
    })
    .slice(0, limit)
    .map((scored) => scored.country)
}
