// Long enough to name the fault, short enough to read on a phone. The
// underlying messages are not sized for a UI at all — a Claude parse
// failure carries a 300-character excerpt of the raw response — and the
// full text is in the logs either way.
const CAUSE_PREVIEW_LENGTH = 160

/**
 * The one-line version of whatever went wrong, for a message a traveler will
 * actually be shown.
 *
 * Extracted from exploreHighlightsCallable (2026-08-16) because the rescan
 * path needed the same thing and had been failing without it. firebase-
 * functions forwards only an HttpsError's message; every other error reaches
 * the browser as the bare code 'internal' with the message "INTERNAL", which
 * the client then can't distinguish from any other failure. That is how
 * three separate rescan failures in a row were reported as the same generic
 * "could not rescan this area", with the actual cause never leaving the
 * server — and it is why the first two fixes for them were guesses.
 */
export function describeCause(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  const collapsed = message.replace(/\s+/g, ' ').trim()
  return collapsed.length > CAUSE_PREVIEW_LENGTH
    ? `${collapsed.slice(0, CAUSE_PREVIEW_LENGTH)}…`
    : collapsed
}
