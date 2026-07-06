import { initializeApp } from 'firebase-admin/app'

initializeApp()

export { createTrip, joinTrip } from './trips.js'
export { generatePlan } from './generatePlan.js'
export { refreshCountryGuide } from './countryGuideCallable.js'
