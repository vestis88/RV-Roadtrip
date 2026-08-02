/**
 * The Firebase client SDK gives up on a callable after 70 seconds by
 * default — while the function itself keeps running, because the client
 * hanging up doesn't cancel it. Every Claude-backed callable in this app
 * declares `timeoutSeconds: 180` server-side precisely because a run with a
 * retry and a round of geocoding plausibly takes longer than a minute, so
 * the client was quietly the *stricter* of the two limits: past 70s the
 * traveler saw "Could not search right now — please try again" while the
 * search went on to succeed and write its stops (reported with a screenshot
 * of exactly that: an error message, and the place found anyway). Retrying
 * then spent a second Claude call on a search that had already worked.
 *
 * Slightly above the server's own ceiling on purpose: whichever limit fires
 * first is the one the traveler sees, and the server's is the one that can
 * explain itself.
 */
export const LONG_CALLABLE_TIMEOUT_MS = 190_000
