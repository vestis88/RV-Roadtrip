/**
 * The sentence a finished rescan puts on screen.
 *
 * Its own module rather than a helper inside RescanCorridorButton: which way
 * to move the map is a rule with two branches and no rendering in it, and
 * the branch that was wrong stayed wrong through several releases precisely
 * because nothing asserted it.
 */
/**
 * What to say when a search comes back.
 *
 * "Nothing new found nearby" was said even when the search had found real
 * places and discarded every one of them for sitting outside the area — a
 * sentence describing a completely different failure from the one that
 * happened, and the reason a narrow search read as a broken one. When
 * something was thrown away, say that instead, and name the fix.
 */
export function describeResult(
  found: number,
  droppedTooFar: number,
  notLocated: number,
  radiusKm: number | undefined,
  capped: boolean,
): string {
  if (found > 0) {
    return `Found ${found} new stop${found === 1 ? '' : 's'} nearby.`
  }
  if (droppedTooFar > 0) {
    // Which way to move the map depends on WHY the circle ended where it
    // did, and this said "zoom in" unconditionally.
    //
    // That is right at the cap and only there: past MAX_RESCAN_RADIUS_KM the
    // circle stops growing with the view, so zooming out only enlarges the
    // part of the screen that ISN'T searched — reported from a map showing
    // the whole of Lithuania, where "zoom out" guaranteed the same answer
    // again. Below the cap the circle tracks the view, so the correct advice
    // is the opposite one, and telling a traveler looking at a 25 km circle
    // to zoom in guarantees the same answer just as reliably. Reported
    // 2026-08-22 from a 7 km circle over Plansee.
    const circle = radiusKm
      ? `the ${Math.round(radiusKm)} km searched`
      : 'the area searched'
    const advice = capped
      ? 'zoom in on them and scan again'
      : 'zoom out and scan again to search wider'
    const one = capped
      ? 'zoom in on it and scan again'
      : 'zoom out and scan again to search wider'
    return droppedTooFar === 1
      ? `Found 1 place, but it was outside ${circle} around the middle of the map — ${one}.`
      : `Found ${droppedTooFar} places, but they were outside ${circle} around the middle of the map — ${advice}.`
  }
  // Not the traveler's problem to fix, and saying "nothing here" would blame
  // the area for what is a map-data failure — see notLocated().
  if (notLocated > 0) {
    return notLocated === 1
      ? 'Suggested 1 place, but it could not be found on the map, so it was dropped.'
      : `Suggested ${notLocated} places, but none of them could be found on the map, so they were dropped.`
  }
  return 'Nothing new found nearby.'
}
