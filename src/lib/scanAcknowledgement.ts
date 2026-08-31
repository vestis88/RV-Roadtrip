/**
 * Which scan's result the traveler has already seen.
 *
 * Reported 2026-08-31: *"The information about the 7 added stops still shows
 * up. It should disappear after looking at any of the stops."*
 *
 * The scan's own result line is written to the TRIP (`planMeta.rescanLastRunAt`
 * and friends) rather than held in component state, and deliberately so: a
 * scan runs for minutes and its answer has to survive the phone that started
 * it going to sleep. The cost of that is a message with no natural end —
 * nothing in the trip document knows whether anyone has read it, so it sat
 * across the map hours later, describing a scan the traveler had long since
 * acted on.
 *
 * The end is the reading. Once you have looked at the results — changed the
 * list to a bucket that holds them, or opened one of them — the sentence has
 * done its job and goes.
 *
 * Kept per viewer rather than on the trip: this is "I have seen it", which is
 * true of one person on one device, and writing it to Firestore would make
 * one traveler's reading dismiss the message for everyone else in the van.
 * localStorage rather than sessionStorage — unlike the pacing banner, which
 * earns one say per app launch, a scan result that has been read is read for
 * good.
 */

const KEY_PREFIX = 'scan-seen:'

/** The `rescanLastRunAt` this device has already acted on, if any. */
export function readSeenScan(tripId: string): string | null {
  try {
    return localStorage.getItem(KEY_PREFIX + tripId)
  } catch {
    // Private browsing, or storage disabled. The message simply keeps its
    // old behaviour rather than the board failing to render.
    return null
  }
}

export function rememberSeenScan(tripId: string, runAt: string): void {
  try {
    localStorage.setItem(KEY_PREFIX + tripId, runAt)
  } catch {
    // Same: not being able to remember is not worth an error.
  }
}
