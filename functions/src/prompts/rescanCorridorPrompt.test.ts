import { describe, expect, it } from 'vitest'
import { buildRescanCorridorPrompt } from './rescanCorridorPrompt.js'

const CENTER = { lat: 47.47, lng: 10.83 }

/**
 * Reported 2026-08-22: a 7 km circle over Plansee came back with four finds,
 * every one of them outside it, and the objection "It was right to limit at
 * 7 km. It was wrong to find nothing within the 7 km. There are for sure
 * things to do!"
 *
 * Both halves of that are addressed here. reverseGeocode.ts stops the search
 * being told it is looking at a 1,200 km² district; these rules stop it
 * answering a small circle with the region's greatest hits, and say what a
 * small circle IS answered by.
 */
describe('what the search is told about the size of its circle', () => {
  const { system } = buildRescanCorridorPrompt({
    center: CENTER,
    radiusKm: 7,
    centerName: 'Plansee, Austria',
  })

  it('says the radius binds, not the name of the area', () => {
    expect(system).toMatch(/RADIUS WINS OVER THE AREA NAME/)
    expect(system).toMatch(/district, a valley, a municipality/)
  })

  it('warns that the regional highlights are the wrong answer when close in', () => {
    expect(system).toMatch(/well-known highlights of the wider region are the wrong answer/)
  })

  // The half that makes it produce something rather than merely produce
  // less: "nothing famous here" is not "nothing here".
  it('says what a small circle is actually answered by', () => {
    expect(system).toMatch(/SMALL RADIUS IS ANSWERED BY ORDINARY THINGS/)
    expect(system).toMatch(/marked trail|viewpoint|mountain hut/)
    expect(system).toMatch(/not for ground that merely has nothing famous on it/)
  })

  // Unchanged, and the reason the two rules above have to coexist: padding
  // is still forbidden, so "propose more" had to be said as "propose at this
  // scale" rather than as a licence to invent.
  it('still forbids padding', () => {
    expect(system).toMatch(/Do not pad/)
  })
})

describe('what the search is told about where it is', () => {
  it('sends the resolved name rather than coordinates when it has one', () => {
    const { user } = buildRescanCorridorPrompt({
      center: CENTER,
      radiusKm: 7,
      centerName: 'Plansee, Austria',
    })
    expect(JSON.parse(user).areaDescription).toBe('Plansee, Austria')
    expect(user).not.toContain('47.47')
  })

  it('falls back to coordinates when reverse geocoding gave nothing', () => {
    const { user } = buildRescanCorridorPrompt({ center: CENTER, radiusKm: 7 })
    expect(JSON.parse(user).areaDescription).toContain('47.47')
  })

  it('always states the radius alongside the area', () => {
    const { user } = buildRescanCorridorPrompt({
      center: CENTER,
      radiusKm: 7,
      centerName: 'Plansee, Austria',
    })
    expect(JSON.parse(user).radiusKm).toBe(7)
  })
})
