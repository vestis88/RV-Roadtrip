import { useTripContext } from '../context/TripContext'
import { ExploreMapScreen } from './ExploreMapScreen'

/**
 * The Map tab. One screen now, at every plan status.
 *
 * WHAT USED TO BE HERE, AND WHY IT IS NOT (2026-08-23).
 *
 * This was a second, separate map screen — the day-by-day one — and the
 * first line of its body was:
 *
 *     if (planStatus === 'idle') return <ExploreMapScreen … />
 *
 * That single condition is the whole of what the traveler reported: "as soon
 * as it goes to detailed plan, I feel like it's too restricting and I
 * actually lose the overview." The overview was not lost to a layout
 * decision, and generation was not deleting it. The board simply stopped
 * being rendered the moment a plan existed, and every action it offers —
 * lock in, set a priority, rescan the area, add a stop — went with it. What
 * was left could show a finished plan and ask for it to be regenerated.
 *
 * So the board is the Map tab now, always, and what the day-by-day view
 * contributed that the board did not — the totals, a way into each day,
 * pacing advice, "Request changes", "Edit route" — is rendered ON it by
 * PlanStrip. A plan is something the trip HAS, not somewhere the traveler
 * GOES.
 *
 * Kept as a component rather than pointing the router straight at
 * ExploreMapScreen, because this is where the Map route reads the trip out
 * of context; ExploreMapScreen takes it as props and is rendered from here
 * and from tests.
 *
 * The day-specific map layers that lived here — per-day overnight pins, the
 * selected day's activity and restaurant markers, and the polyline threaded
 * through each day's best activity — are in git history at 3529d59. They are
 * not carried over because the board draws the same route from the locked
 * stops those days are built from, and the per-day places remain on Day
 * View, which the day strip now opens.
 */
export function OverviewMapScreen() {
  const { tripId, trip } = useTripContext()
  return <ExploreMapScreen tripId={tripId} trip={trip} />
}

export default OverviewMapScreen
