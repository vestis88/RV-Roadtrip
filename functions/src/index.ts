// globalOptions must be the FIRST import: ESM evaluates imported modules
// before this module's body, so an inline setGlobalOptions() call here would
// run only AFTER trips.js/generatePlan.js have already defined their
// functions with the default us-central1 region baked in.
import './globalOptions.js'
import { initializeApp } from 'firebase-admin/app'

initializeApp()

export { createTrip, joinTrip } from './trips.js'
export { generatePlan } from './generatePlan.js'
export { refreshCountryGuide } from './countryGuideCallable.js'
