import { describe, expect, it, vi } from 'vitest'

vi.mock('firebase/firestore', () => ({ doc: () => ({}), setDoc: vi.fn() }))
vi.mock('firebase/functions', () => ({ httpsCallable: () => vi.fn() }))
vi.mock('./firebase', () => ({ db: {}, functions: {} }))

const {
  GENERIC_RESEARCH_ERROR,
  describePartialResearchFailure,
  describeResearchError,
} = await import('./countryBriefActions')

const titleOf = (id: string) =>
  ({ driving: 'Driving rules', camping: 'Camping rules' })[id] ?? id

// Reported 2026-08-18 with a screenshot of Germany: four unresearched
// sections, and "Could not research that right now — please try again" as the
// entire account of why. Every failure was replaced with that line, including
// ones the server had written for exactly this moment.
describe('describeResearchError', () => {
  it('shows the server message when the server wrote one', () => {
    expect(
      describeResearchError({
        code: 'functions/invalid-argument',
        message: 'None of those sections are in your research list',
      }),
    ).toBe('None of those sections are in your research list')
  })

  // Each section is its own web-search-backed Claude call and they all run at
  // once against one 180s ceiling, so "try again" asks for the same race.
  it('names the lever that helps when the research ran out of time', () => {
    const said = describeResearchError({
      code: 'functions/deadline-exceeded',
      message: 'deadline-exceeded',
    })
    expect(said).toMatch(/one section at a time/i)
    expect(said).not.toBe(GENERIC_RESEARCH_ERROR)
  })

  it('falls back only when the rejection carries no cause at all', () => {
    expect(describeResearchError(new TypeError('Failed to fetch'))).toBe(
      GENERIC_RESEARCH_ERROR,
    )
    expect(
      describeResearchError({ code: 'functions/internal', message: 'internal' }),
    ).toBe(GENERIC_RESEARCH_ERROR)
  })
})

// The other half: the call succeeds and individual sections fail. The server
// caught each one, logged it, and returned the bare section id — so the
// screen could only ever count them.
describe('describePartialResearchFailure', () => {
  it('names the cause the server recorded', () => {
    const said = describePartialResearchFailure(
      ['driving'],
      1,
      { driving: 'Claude returned no JSON: the web search tool was unavailable' },
      titleOf,
    )
    expect(said).toContain('Driving rules')
    expect(said).toContain('web search tool was unavailable')
  })

  it('says plainly when nothing at all could be researched', () => {
    const said = describePartialResearchFailure(
      ['driving', 'camping'],
      2,
      { driving: 'Rate limited', camping: 'Rate limited' },
      titleOf,
    )
    expect(said).toContain('any of the 2 sections')
    // One distinct cause, said once — not twice.
    expect(said.match(/Rate limited/g)).toHaveLength(1)
  })

  it('still reassures that the rest were saved on a partial failure', () => {
    const said = describePartialResearchFailure(
      ['driving'],
      4,
      { driving: 'Rate limited' },
      titleOf,
    )
    expect(said).toContain('1 of 4')
    expect(said).toContain('the rest are saved')
  })

  it('summarises rather than lists when the causes differ', () => {
    const said = describePartialResearchFailure(
      ['driving', 'camping'],
      2,
      { driving: 'Rate limited', camping: 'No JSON in the response' },
      titleOf,
    )
    expect(said).toContain('2 different causes')
    expect(said).toContain('Rate limited')
  })

  // An older deployment returns no reasons at all; the count on its own is
  // still better than nothing.
  it('works when the server sent no reasons', () => {
    const said = describePartialResearchFailure(['driving'], 4, {}, titleOf)
    expect(said).toContain('1 of 4')
  })
})
