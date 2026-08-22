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

/**
 * The third fix for the same report, and the one that stops asking the
 * question that could not be answered.
 *
 * A 6 km circle over the Plansee came back "found 5, all outside" while
 * Google's own map drew the Höllkopf viewpoint, the Stuibenfälle, the
 * Soldatenkopf trail, a campsite and a guest house inside it. The model was
 * being asked to recall what lies within a few kilometres of a
 * reverse-geocoded name, with no coordinates and no tools. Places knows
 * exactly, and can be made to answer with a hard bound.
 */
describe('the real places inside the circle', () => {
  const places = ['Aussichtsplattform Höllkopf', 'Stuibenfälle', 'Campingplatz Fischer am See']

  it('is handed the list when the sweep found something', () => {
    const { user } = buildRescanCorridorPrompt({
      center: CENTER,
      radiusKm: 6,
      centerName: 'Plansee, Austria',
      placesInArea: places,
    })
    expect(JSON.parse(user).placesInArea).toEqual(places)
  })

  // A failed sweep must leave the search working exactly as before, not
  // send an empty list that reads as "there is nothing here".
  it('omits the key entirely when the sweep found nothing', () => {
    const { user } = buildRescanCorridorPrompt({
      center: CENTER,
      radiusKm: 6,
      placesInArea: [],
    })
    expect(JSON.parse(user)).not.toHaveProperty('placesInArea')
  })

  it('tells the model the list is a hard bound, not a suggestion', () => {
    const { system } = buildRescanCorridorPrompt({ center: CENTER, radiusKm: 6 })
    expect(system).toMatch(/USE "placesInArea" WHEN IT IS GIVEN/)
    expect(system).toMatch(/not near it, inside it/)
  })

  // The judgement is still the model's — a raw Places dump ranked by rating
  // is exactly what this call exists not to be.
  it('still asks which of them are worth stopping for', () => {
    const { system } = buildRescanCorridorPrompt({ center: CENTER, radiusKm: 6 })
    expect(system).toMatch(/choosing the ones genuinely worth stopping for/)
    expect(system).toMatch(/may add a place that is not on the list/)
  })

  it('forbids reading an empty list as an empty area', () => {
    const { system } = buildRescanCorridorPrompt({ center: CENTER, radiusKm: 6 })
    expect(system).toMatch(/may not use the list's absence as evidence/)
  })
})
