import { initializeApp } from 'firebase-admin/app'

initializeApp()

export { createTrip, joinTrip } from './trips.js'
