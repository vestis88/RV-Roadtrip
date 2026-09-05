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

/**
 * Reported 2026-09-05 over a 150 km circle across central Italy: "Searched
 * 150 km of Italy and it found one stop?! I want it to find the best of the
 * region. There must be A LOT more!!" — and one find is what the model
 * returned. The only things this prompt had ever said about quantity were
 * "do not pad" and "an empty list is a valid and honest answer": two
 * arguments for fewer, and nothing at all for more. `MAX_RESCAN_RESULTS`
 * existed the whole time as a server-side slice the model was never told
 * about.
 */
describe('how many places the search is asked for', () => {
  it('names a target, and says it is a size rather than a ceiling to stay under', () => {
    const { system } = buildRescanCorridorPrompt({ center: CENTER, radiusKm: 150 })
    expect(system).toMatch(/PROPOSE AS MANY AS THE GROUND HOLDS, up to "howManyToPropose"/)
    expect(system).toMatch(/not a ceiling to stay well under/)
  })

  it('carries the number itself, so the target is a fact and not a guess', () => {
    const { user } = buildRescanCorridorPrompt({
      center: CENTER,
      radiusKm: 150,
      targetFinds: 12,
    })
    expect(JSON.parse(user).howManyToPropose).toBe(12)
  })

  it('asks for them spread across the area rather than around its centre', () => {
    const { system } = buildRescanCorridorPrompt({ center: CENTER, radiusKm: 150 })
    expect(system).toMatch(/Spread them across the WHOLE area/)
  })

  // The counterweight survives: this must not become a padding instruction.
  it('still says fewer is the honest answer for ground that holds fewer', () => {
    const { system } = buildRescanCorridorPrompt({ center: CENTER, radiusKm: 6 })
    expect(system).toMatch(/Do not pad, either/)
    expect(system).toMatch(/an empty "finds" list is a valid and honest answer/)
  })
})

/**
 * Reported 2026-09-05 with a screenshot of eight finds clustered in one
 * valley: *"What's the reason for the grouping of the results?"*
 *
 * It was the geography, not the curation. The search is given no coordinates
 * at all — deliberately, so it cannot invent distances — which makes the
 * reverse-geocoded centre name the ENTIRE statement of where it is looking.
 * That name is picked most-specific-first, so a circle centred on a regional
 * park was told "Parco Naturale Regionale Sirente-Velino, radius 150 km" and
 * answered with those mountains. Nothing in the prompt said the same area
 * also held the Adriatic and Rome.
 */
describe('what the search is told about how far the area reaches', () => {
  const corners = {
    northWest: 'Terni, Italy',
    northEast: 'Giulianova, Italy',
    southWest: 'Latina, Italy',
    southEast: 'Vasto, Italy',
  }

  it('names the corners, so the span is stated and not inferred', () => {
    const { user } = buildRescanCorridorPrompt({
      center: CENTER,
      radiusKm: 150,
      centerName: 'Parco Naturale Regionale Sirente-Velino',
      areaCorners: corners,
      areaSpanKm: { width: 240, height: 170 },
    })

    const sent = JSON.parse(user)
    expect(sent.areaCorners).toEqual(corners)
    expect(sent.areaSpanKm).toEqual({ width: 240, height: 170 })
    // The centre still says where the middle is; it just no longer has to
    // carry the whole description on its own.
    expect(sent.areaDescription).toBe('Parco Naturale Regionale Sirente-Velino')
  })

  it('says the rectangle is the area and the centre name is not', () => {
    const { system } = buildRescanCorridorPrompt({ center: CENTER, radiusKm: 150 })
    expect(system).toMatch(/THE AREA IS A RECTANGLE, AND IT IS DESCRIBED TO YOU IN FULL/)
    expect(system).toMatch(/THE CENTRE NAME IS NOT THE AREA/)
    expect(system).toMatch(/rather than clustering around whatever the centre happens to be sitting on/)
  })

  /**
   * *"I would expect you to come up with a way to define the area of
   * interest to Claude in a reasonable way. I don't want google places to
   * cloud Claude's own thinking here!"*
   *
   * The geocoder says what the area is called; Places says what is listed
   * inside it, ranked by review count. The first is geography and belongs in
   * the prompt. The second, over a region, is the answer in disguise.
   */
  it('names the regions the area spans, from the geocoder', () => {
    const { user } = buildRescanCorridorPrompt({
      center: CENTER,
      radiusKm: 150,
      areaCorners: corners,
      areaRegions: ['Abruzzo', 'Lazio', 'Marche'],
      areaCountries: ['Italy'],
    })

    const sent = JSON.parse(user)
    expect(sent.areaRegions).toEqual(['Abruzzo', 'Lazio', 'Marche'])
    expect(sent.areaCountries).toEqual(['Italy'])
  })

  it('says a wide area is answered from the model’s own knowledge', () => {
    const { system } = buildRescanCorridorPrompt({ center: CENTER, radiusKm: 150 })
    expect(system).toMatch(/OVER A LARGE AREA YOU ARE WORKING FROM YOUR OWN KNOWLEDGE/)
    expect(system).toMatch(/a popularity chart, not an answer/)
  })

  // Two shapes in one payload is an invitation to reconcile them.
  it('drops the radius once the rectangle is stated', () => {
    const { user } = buildRescanCorridorPrompt({
      center: CENTER,
      radiusKm: 150,
      areaCorners: corners,
    })
    expect(JSON.parse(user).radiusKm).toBeUndefined()
  })

  it('keeps the radius when there is no rectangle to describe', () => {
    const { user } = buildRescanCorridorPrompt({ center: CENTER, radiusKm: 25 })
    expect(JSON.parse(user).radiusKm).toBe(25)
  })
})
