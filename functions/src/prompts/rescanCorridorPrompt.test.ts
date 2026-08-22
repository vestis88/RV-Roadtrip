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

  it('says everything on the list really is inside the circle', () => {
    const { system } = buildRescanCorridorPrompt({ center: CENTER, radiusKm: 6 })
    expect(system).toMatch(/everything on it is genuinely in there/)
  })

  /**
   * The scar this codebase already carries once, from web search: a source
   * offered to a model becomes a GATE on what it is allowed to say unless
   * the prompt is explicit that it is not one. web_search was removed on
   * 2026-08-16 for exactly that — three queries over a viewport, and
   * anything they missed was forbidden, including everything the model
   * already knew. Handing it a Places list has the same shape, so it gets
   * the same warning in the opposite direction.
   */
  it('is explicit that the list is a floor and not a ceiling', () => {
    const { system } = buildRescanCorridorPrompt({ center: CENTER, radiusKm: 6 })
    expect(system).toMatch(/FLOOR, NOT A CEILING/)
    expect(system).toMatch(/NOT the complete set/)
  })

  it('asks for the places Google has no listing for', () => {
    const { system } = buildRescanCorridorPrompt({ center: CENTER, radiusKm: 6 })
    expect(system).toMatch(/trailheads, swimming spots, free-camping/)
    expect(system).toMatch(/A good answer that Google has never heard of/)
  })

  it('forbids reading absence from the list as absence on the ground', () => {
    const { system } = buildRescanCorridorPrompt({ center: CENTER, radiusKm: 6 })
    expect(system).toMatch(/Never treat absence from the list as evidence/)
  })
})

/**
 * Reported 2026-08-22: "here are a lot of references to 'already on my list',
 * but I can't find any other stops. Why?"
 *
 * Because the search had never been told what the list was. The prompt
 * carried interests, freeform notes, route waypoints and the Places sweep —
 * and nothing about the corridor's own stops. So "already on your list" could
 * only ever have meant a line in the NOTES, which is not a stop, or nothing
 * at all; and the traveler reads it as "this is already a stop" and goes
 * looking for it.
 */
describe('what the traveler already has', () => {
  const mine = ['Cima Grappa', 'Greenway Fiume Sile']

  it('sends the trip’s own stops when it has some', () => {
    const { user } = buildRescanCorridorPrompt({
      center: CENTER,
      radiusKm: 60,
      existingStopNames: mine,
    })
    expect(JSON.parse(user).alreadyOnTheList).toEqual(mine)
  })

  it('omits the key entirely on a trip with no stops yet', () => {
    const { user } = buildRescanCorridorPrompt({
      center: CENTER,
      radiusKm: 60,
      existingStopNames: [],
    })
    expect(JSON.parse(user)).not.toHaveProperty('alreadyOnTheList')
  })

  it('caps a long corridor rather than sending everything', () => {
    const many = Array.from({ length: 200 }, (_, i) => `Stop ${i}`)
    const { user } = buildRescanCorridorPrompt({
      center: CENTER,
      radiusKm: 60,
      existingStopNames: many,
    })
    expect(JSON.parse(user).alreadyOnTheList.length).toBeLessThanOrEqual(60)
  })

  /**
   * The half the report was actually about, and the stronger reading of it.
   *
   * The first version of this rule allowed the phrase when it was TRUE —
   * only about a name on the list. Then the traveler confirmed the places
   * were not in their notes either, which leaves nothing the model could
   * have been reading: it simply asserted it. A rule that permits a claim
   * under a condition the model evaluates itself is a rule about its
   * judgement; forbidding the claim outright is a rule about its output.
   *
   * It costs nothing, either. Whether a stop is saved is something the APP
   * knows for certain and already marks on every card — "On route",
   * "Locked in" — so this is a fact the model was never the right source
   * for.
   */
  it('forbids claiming anything is already saved, true or not', () => {
    const { system } = buildRescanCorridorPrompt({ center: CENTER, radiusKm: 60 })
    expect(system).toMatch(/NEVER write that something is "already on your list"/)
    expect(system).toMatch(/already on your radar/)
    expect(system).toMatch(/never refer to the traveler's other stops, their route or their itinerary/)
  })

  it('says who owns that fact instead', () => {
    const { system } = buildRescanCorridorPrompt({ center: CENTER, radiusKm: 60 })
    expect(system).toMatch(/The app already shows the traveler what is on their list/)
  })

  // The list is still sent, and still does its actual job.
  it('keeps using the list to avoid proposing duplicates', () => {
    const { system } = buildRescanCorridorPrompt({ center: CENTER, radiusKm: 60 })
    expect(system).toMatch(/do not propose them again/i)
  })
})
