/**
 * How big a circle "Rescan this area" covers.
 *
 * Their own module, with no Firebase import behind them, so a Playwright
 * spec can name the cap instead of hardcoding a number. The e2e test for the
 * out-of-area message hardcoded 50, which was the cap when it was written;
 * when the cap moved to 150 the test kept passing while quietly no longer
 * exercising the case it described.
 */
/**
 * The fallback when the map hasn't reported its bounds yet. Everything else
 * uses the viewport — see visibleRadiusKm.
 */
export const RESCAN_RADIUS_KM = 25

/**
 * The callable's own cap, mirrored so the client can say when it bites.
 *
 * Raised from 50 on 2026-08-17, because what set it at 50 no longer applies.
 * It was a cost guard from when a rescan ran up to three web searches per
 * turn and the bill grew with the ground covered. The search is now one
 * tool-free Claude call returning at most MAX_RESCAN_RESULTS finds, and that
 * costs the same whether it is asked about 25 km or 150. What remains is a
 * quality bound — "what is worth stopping for within 500 km of here" is a
 * worse question than "within 100 km", not a more expensive one — so the cap
 * stays, at a size that covers a normal regional view instead of a city one.
 */
export const MAX_RESCAN_RADIUS_KM = 150

/**
 * The smallest circle "this area" is ever allowed to mean.
 *
 * Reported 2026-08-22 from a map centred on Plansee: "Found 4 places, but
 * they were outside the 7 km searched" — with Neuschwanstein, Füssen,
 * Linderhof and the Ehrenberg ruins all just beyond it, and the objection
 * "There should be things to do in the area!!" There are. The search was
 * 7 km wide.
 *
 * Tracking the viewport was the right fix for a viewport LARGER than the
 * circle (see visibleRadiusKm), and it was applied in both directions
 * without asking whether the small end meant anything. It does not. The map
 * pane on a phone is a band a few hundred pixels tall with a card list under
 * it, so an ordinary look at a lake is a 7 km circle — while the traveler
 * pointing at that lake means "around here", and in a vehicle that does
 * 2,000 km in a trip, "around here" is not seven kilometres.
 *
 * The two failure modes are not symmetrical, which is what decides the
 * floor. Too small returns NOTHING and cannot be recovered from by looking
 * harder — it is the empty answer that started all of this. Too large
 * returns places that are further away than ideal, each one carrying its own
 * detour badge, for the traveler to keep or turn down. Choices beat silence.
 *
 * 25 km, which is what the fixed radius was before viewports were consulted
 * at all — a value that never produced this complaint.
 */
export const MIN_RESCAN_RADIUS_KM = 25
