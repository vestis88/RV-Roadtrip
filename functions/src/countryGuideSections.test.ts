import { describe, expect, it } from 'vitest'
import { freeCampingPolicy } from './countryGuideSections.js'

/**
 * The verdict this produces is what decides whether a night of the trip is
 * committed to a free spot, so the cases below are the real shapes the
 * researched findings come in — permissive north, prohibitive middle, strict
 * south — rather than invented sentences.
 */
describe('freeCampingPolicy', () => {
  it('permits a night where the country has a named right to roam', () => {
    const policy = freeCampingPolicy([
      'Allemannsretten gives everyone the right to camp for up to two nights on uncultivated land, at least 150m from the nearest inhabited house.',
      'Camping is restricted in some national parks; check the park’s own signage.',
    ])
    expect(policy.permitted).toBe(true)
    expect(policy.rule).toContain('Allemannsretten')
  })

  // The caveat is the norm, not the exception — every right-to-roam country's
  // findings carry one. Reading the verdict per sentence is what keeps a
  // national-park restriction from cancelling the national right.
  it('is not talked out of the right by a caveat in the next sentence', () => {
    const policy = freeCampingPolicy([
      'Allemansrätten allows one night on uncultivated land. Camping is prohibited within sight of a dwelling and in nature reserves.',
    ])
    expect(policy.permitted).toBe(true)
  })

  // A guide for a strict country routinely explains itself by pointing at a
  // permissive neighbour. That sentence is about Sweden, in Denmark's guide.
  it('does not read a neighbour’s right to roam as this country’s', () => {
    const policy = freeCampingPolicy([
      'Unlike Sweden’s allemansrätten, Denmark does not allow free camping outside designated sites.',
    ])
    expect(policy.permitted).toBe(false)
    expect(policy.rule).toContain('Denmark')
  })

  it('refuses where the country prohibits it outside designated spots', () => {
    const policy = freeCampingPolicy([
      'Wild camping is prohibited in Germany outside designated Stellplätze and campsites.',
      'Sleeping one night in a motorhome to restore fitness to drive is tolerated in some Länder.',
    ])
    expect(policy.permitted).toBe(false)
    expect(policy.rule).toContain('prohibited')
  })

  // The strict countries read as "allowed in this one named case, banned
  // otherwise". A prohibition anywhere in the findings has to outrank a bare
  // permission elsewhere in them, or the exception becomes the rule.
  it('lets a prohibition outrank a permission stated elsewhere', () => {
    const policy = freeCampingPolicy([
      'Overnight parking is permitted at some motorway service areas.',
      'Free camping is illegal in Croatia and fines are enforced, including on private land.',
    ])
    expect(policy.permitted).toBe(false)
  })

  it('takes an explicit statement that it is legal, with no named right', () => {
    const policy = freeCampingPolicy([
      'Camping outside campsites is legal in Scotland under the Land Reform Act, away from roads and buildings.',
    ])
    expect(policy.permitted).toBe(true)
  })

  // An unresearched country is exactly the case where nobody has checked, so
  // it must not read as permission.
  it('treats an unresearched country as not permitted', () => {
    expect(freeCampingPolicy(undefined)).toEqual({ permitted: false, rule: null })
    expect(freeCampingPolicy([])).toEqual({ permitted: false, rule: null })
  })

  // Findings that never address legality at all (practical tips only) are
  // silence, not consent.
  it('treats findings that say nothing about legality as not permitted', () => {
    const policy = freeCampingPolicy([
      'Fresh water can usually be refilled at cemeteries and service stations.',
    ])
    expect(policy).toEqual({ permitted: false, rule: null })
  })
})
