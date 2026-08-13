import { describe, expect, it } from 'vitest'
import {
  ALL_COUNTRIES,
  EUROPEAN_COUNTRIES,
  countryChipOptions,
  countryLabel,
  countryName,
  searchCountries,
} from './countries'

const codes = (results: { code: string }[]) => results.map((r) => r.code)

describe('ALL_COUNTRIES', () => {
  // The constraint the whole picker is built around: tripSettingsSchema has
  // `preferredCountries: z.array(z.string().length(2))`, and a settings
  // write that violates it doesn't fail visibly — it leaves a trip document
  // that no longer parses. Since every value the picker can produce comes
  // from this list, checking the list is checking every write.
  it('holds only two-letter uppercase codes, with no duplicates', () => {
    for (const country of ALL_COUNTRIES) {
      expect(country.code).toMatch(/^[A-Z]{2}$/)
      expect(country.name.length).toBeGreaterThan(1)
      // A name that is just the code back again means the entry never
      // resolved — that's the "LU" the Countries tab used to show.
      expect(country.name).not.toBe(country.code)
    }
    expect(new Set(codes(ALL_COUNTRIES)).size).toBe(ALL_COUNTRIES.length)
  })

  it('covers the ISO 3166-1 list, not just the corner of Europe', () => {
    // 249 assigned alpha-2 codes, plus XK for Kosovo.
    expect(ALL_COUNTRIES).toHaveLength(250)
    // The country from the bug report, and a few that are easy to lose when
    // a list like this is hand-edited.
    for (const code of ['LU', 'IS', 'GR', 'RO', 'AL', 'XK', 'MA', 'TR']) {
      expect(codes(ALL_COUNTRIES)).toContain(code)
    }
  })

  it('names every quick-pick chip from the same list the picker searches', () => {
    for (const quick of EUROPEAN_COUNTRIES) {
      expect(ALL_COUNTRIES).toContainEqual(quick)
    }
  })
})

describe('countryName', () => {
  it('names any country, not only the quick picks', () => {
    expect(countryName('LU')).toBe('Luxembourg')
    expect(countryName('NO')).toBe('Norway')
  })

  it('accepts a lowercase code, since stored data is only schema-checked for length', () => {
    expect(countryName('lu')).toBe('Luxembourg')
  })

  it('falls back to the code itself for something it does not know', () => {
    expect(countryName('QQ')).toBe('QQ')
  })
})

describe('countryLabel', () => {
  it('pairs the flag with the name, so the traveler can see the code resolved', () => {
    expect(countryLabel('LU')).toBe('🇱🇺 Luxembourg')
  })
})

describe('countryChipOptions', () => {
  it('keeps the quick picks in place and appends a chosen extra at the end', () => {
    const options = countryChipOptions(['NO', 'LU'])
    expect(options).toHaveLength(EUROPEAN_COUNTRIES.length + 1)
    expect(options[0].value).toBe('NO')
    expect(options.at(-1)).toEqual({ value: 'LU', label: '🇱🇺 Luxembourg' })
  })

  it('does not duplicate a selected country that is already a quick pick', () => {
    const options = countryChipOptions(['IT', 'FR'])
    expect(options).toHaveLength(EUROPEAN_COUNTRIES.length)
  })

  it('appends extras in the order they were chosen, so the newest is where the eye is', () => {
    const options = countryChipOptions(['LU', 'IS'])
    expect(codes(options.slice(-2).map((o) => ({ code: o.value })))).toEqual([
      'LU',
      'IS',
    ])
  })
})

describe('searchCountries', () => {
  it('returns nothing for an empty or punctuation-only query', () => {
    expect(searchCountries('')).toEqual([])
    expect(searchCountries('   ')).toEqual([])
    expect(searchCountries('-')).toEqual([])
  })

  it('finds the country the bug report was about', () => {
    expect(codes(searchCountries('luxem'))).toEqual(['LU'])
  })

  // The reported trip was named "Luxemburg" — the German/Dutch/Nordic
  // spelling — so that is exactly what its owner would type, and a strict
  // substring match returns nothing for it.
  it('forgives a near-miss spelling like "Luxemburg"', () => {
    expect(codes(searchCountries('luxemburg'))).toContain('LU')
  })

  it('matches an exact two-letter code first', () => {
    expect(searchCountries('lu')[0].code).toBe('LU')
    expect(searchCountries('IS')[0].code).toBe('IS')
  })

  it('ignores case and accents in both the query and the name', () => {
    expect(codes(searchCountries("cote d'ivoire"))).toContain('CI')
    expect(codes(searchCountries('CURACAO'))).toContain('CW')
    expect(codes(searchCountries('turkiye'))).toContain('TR')
  })

  it('knows the names people still use for renamed countries', () => {
    expect(searchCountries('turkey')[0].code).toBe('TR')
    expect(searchCountries('czech republic')[0].code).toBe('CZ')
    expect(searchCountries('holland')[0].code).toBe('NL')
    expect(searchCountries('england')[0].code).toBe('GB')
    expect(searchCountries('swaziland')[0].code).toBe('SZ')
  })

  it('ranks a name that starts with the query above one that merely contains it', () => {
    const results = codes(searchCountries('ice'))
    expect(results[0]).toBe('IS')
  })

  // This is a European road-trip planner: "sw" should reach the countries
  // its trips actually drive through before the rest of the alphabet.
  it('breaks ties toward the quick-pick countries', () => {
    const results = codes(searchCountries('swi'))
    expect(results[0]).toBe('CH')
  })

  it('caps the list so the results never bury the chips above them', () => {
    expect(searchCountries('a').length).toBeLessThanOrEqual(6)
    expect(searchCountries('an', 3)).toHaveLength(3)
  })

  it('is stable: the same query always ranks the same way', () => {
    expect(codes(searchCountries('gu'))).toEqual(codes(searchCountries('gu')))
  })

  it('only ever returns codes the settings schema will accept', () => {
    for (const query of ['a', 'united', 'luxemburg', 'ivory coast', 'is']) {
      for (const country of searchCountries(query)) {
        expect(country.code).toMatch(/^[A-Z]{2}$/)
      }
    }
  })
})
