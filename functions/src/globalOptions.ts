import { setGlobalOptions } from 'firebase-functions/options'

// Keep all functions in the same region as Firestore (europe-west1).
// europe-north2 (Stockholm) is NOT supported for Cloud Functions triggers.
setGlobalOptions({ region: 'europe-west1' })
