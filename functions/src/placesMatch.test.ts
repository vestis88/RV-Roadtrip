import { describe, expect, it } from 'vitest'
import { __testing } from './placesApi.js'

const { nameLooksRight, nameTokens } = __testing

describe('nameTokens', () => {
  it('folds case, diacritics and punctuation', () => {
    expect(nameTokens('Møns Klint!')).toEqual(['mons', 'klint'])
    expect(nameTokens('CAFÉ  Sletten')).toEqual(['sletten'])
  })

  it('drops generic nouns that would match anything of that kind', () => {
    expect(nameTokens('Restaurant Sletten')).toEqual(['sletten'])
    expect(nameTokens('Hotel Bella Vista')).toEqual(['bella', 'vista'])
  })
})

describe('nameLooksRight', () => {
  it('accepts a fuller listing name for the same place', () => {
    expect(nameLooksRight('Kronborg', 'Kronborg Castle')).toBe(true)
    expect(nameLooksRight('Møns Klint', 'Mons Klint Cliffs')).toBe(true)
  })

  it('accepts a shorter listing name for the same place', () => {
    expect(nameLooksRight('Restaurant Sletten', 'Sletten')).toBe(true)
  })

  // The Berlin case: a famous landmark answering for a small cafe. Distance
  // never catches this one — the outlet is well inside the radius.
  it('rejects an unrelated landmark that merely shares the town', () => {
    expect(nameLooksRight('Café Anna Blume', 'Designer Outlet Berlin')).toBe(
      false,
    )
  })

  it('rejects a partial overlap that misses most of the name', () => {
    expect(nameLooksRight('Bella Vista Village', 'Village Green Diner')).toBe(
      false,
    )
  })

  // Backfill asks for a category, not a place — anything of that kind is a
  // correct answer, so there is nothing to check against.
  it('passes anything through when no name was requested', () => {
    expect(nameLooksRight(undefined, 'Designer Outlet Berlin')).toBe(true)
  })

  it('passes through when the request is entirely generic words', () => {
    expect(nameLooksRight('The Restaurant', 'Designer Outlet Berlin')).toBe(true)
  })
})

// Regression: ø/æ/ß are letters, not decomposable accents, so NFD leaves
// them and the ASCII strip would delete them outright — "Møns" became "ns"
// and stopped matching Places' own "Mons Klint". Scandinavian names are the
// common case for this app, not an edge case.
describe('nameTokens on non-decomposing letters', () => {
  it('transliterates Nordic letters rather than deleting them', () => {
    expect(nameTokens('Møns Klint')).toEqual(['mons', 'klint'])
    expect(nameTokens('Ærø')).toEqual(['aero'])
    expect(nameTokens('Strauß')).toEqual(['strauss'])
  })

  it('still folds the accents that do decompose', () => {
    expect(nameTokens('Åre Skidort')).toEqual(['are', 'skidort'])
    expect(nameTokens('Zürich')).toEqual(['zurich'])
  })

  it('matches a Danish name against its de-accented Places listing', () => {
    expect(nameLooksRight('Møns Klint', 'Mons Klint')).toBe(true)
  })
})
