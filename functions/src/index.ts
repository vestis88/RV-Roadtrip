import { initializeApp } from 'firebase-admin/app'
import { setGlobalOptions } from 'firebase-functions/options'

setGlobalOptions({ region: 'europe-west1' })
initializeApp()

export { createTrip, joinTrip } from './trips.js'
export { generatePlan } from './generatePlan.js'
export { refreshCountryGuide } from './countryGuideCallable.js'
