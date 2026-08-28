import { describe, expect, it } from 'vitest'
import { searchSourceNote } from './searchSourceNote'

/**
 * Reported 2026-08-28: "The results seem to be based solely on Google Maps
 * results again?" They were, because the Anthropic account had run out of
 * credit — and nothing on screen said so, which made a working fallback
 * indistinguishable from the regression reported four days earlier.
 */
describe('searchSourceNote', () => {
  it('says nothing when the search that was asked for is the one that answered', () => {
    expect(searchSourceNote('claude')).toBeNull()
    expect(searchSourceNote('claude', 'credit')).toBeNull()
  })

  // The actual production failure, and the only kind with a fix the traveler
  // can carry out themselves.
  it('names the credit failure and where to fix it', () => {
    const note = searchSourceNote('places', 'credit')
    expect(note).toContain('Google Maps')
    expect(note).toContain('credit')
    expect(note).toContain('Anthropic console')
  })

  /**
   * The distinction the whole module exists for. Claude answering "nothing
   * here" is a fact about the area; Claude being unreachable is a fact about
   * us, and reading one as the other is what cost an evening.
   */
  it('does not let an empty answer read as an outage', () => {
    const empty = searchSourceNote('places')
    const broken = searchSourceNote('places', 'other')
    expect(empty).not.toEqual(broken)
    expect(empty).toContain('nothing to add')
    expect(broken).toContain('could not be reached')
  })

  it('gives each failure its own answer', () => {
    expect(searchSourceNote('places', 'rate-limit')).toContain('a minute')
    expect(searchSourceNote('places', 'auth')).toContain('deployment')
    expect(searchSourceNote('places', 'timeout')).toContain('again')
  })

  // A search that has not run yet has nothing to explain.
  it('says nothing when no search has reported a source', () => {
    expect(searchSourceNote(undefined)).toBeNull()
  })
})
