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

