// globalOptions must be the FIRST import: ESM evaluates imported modules
// before this module's body, so an inline setGlobalOptions() call here would
// run only AFTER trips.js/generatePlan.js have already defined their
// functions with the default us-central1 region baked in.
import './globalOptions.js'
import { initializeApp } from 'firebase-admin/app'
import { getFirestore } from 'firebase-admin/firestore'

initializeApp()
// Places API responses routinely omit optional fields (rating, photos,
// opening hours, price level, ...). Building Activity/Restaurant docs from
// them via plain property assignment leaves those keys explicitly
// `undefined`, which the Admin SDK rejects by default ("Cannot use
// 'undefined' as a Firestore value") — these fields are genuinely optional
// in the schema, so omitting them is correct, not a bug to work around.
getFirestore().settings({ ignoreUndefinedProperties: true })

// The gate every other callable sits behind — see accessControl.ts. It is
// deliberately the one callable that does not require the access claim.
export { claimAccess } from './claimAccessCallable.js'
export { createTrip, joinTrip } from './trips.js'
export { createTripShareLink, revokeTripShareLink } from './shareTokens.js'
export { viewSharedTrip } from './viewSharedTrip.js'
export { mergeTrips } from './mergeTrips.js'
export { deleteTrip } from './deleteTrip.js'
export { generatePlan } from './generatePlan.js'
export { researchCountrySections } from './countrySectionsCallable.js'
export { getOvernightCandidates } from './overnightCandidatesCallable.js'
export { refreshOvernightOptions } from './refreshOvernightOptionsCallable.js'
export { rescanCorridor } from './rescanCorridorCallable.js'
export { detailDays } from './detailDaysCallable.js'
export { generateExploreHighlights } from './exploreHighlightsCallable.js'
export { previewReconcileCorridor } from './previewReconcileCorridorCallable.js'
export { researchMoreAlternatives } from './researchMoreAlternativesCallable.js'
