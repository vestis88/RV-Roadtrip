import { initializeApp } from 'firebase/app'
import {
  connectAuthEmulator,
  getAuth,
  onAuthStateChanged,
  type User,
} from 'firebase/auth'
import {
  connectFirestoreEmulator,
  initializeFirestore,
  persistentLocalCache,
  persistentMultipleTabManager,
} from 'firebase/firestore'
import { connectFunctionsEmulator, getFunctions } from 'firebase/functions'

const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID ?? 'demo-rv-trip-planner',
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
}

export const app = initializeApp(firebaseConfig)
export const auth = getAuth(app)
export const db = initializeFirestore(app, {
  localCache: persistentLocalCache({
    tabManager: persistentMultipleTabManager(),
  }),
})
// Must match the region pinned via setGlobalOptions in functions/src/index.ts —
// callable URLs embed the region, so a mismatch 404s every createTrip/joinTrip.
export const functions = getFunctions(app, 'europe-west1')

if (import.meta.env.VITE_USE_FIREBASE_EMULATORS === 'true') {
  connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true })
  connectFirestoreEmulator(db, '127.0.0.1', 8080)
  connectFunctionsEmulator(functions, '127.0.0.1', 5001)
}

/**
 * Resolves with whoever is already signed in, once Firebase has reported
 * an auth state.
 *
 * It used to sign the visitor in ANONYMOUSLY when nobody was — which is
 * how opening the bare URL granted an account, a trip, a share code and a
 * working "Generate plan" button to anyone who found the address. Sign-in
 * is now the AccessGate's job, and nothing that calls this mounts until
 * the gate has granted access, so a missing user here is a bug rather
 * than a case to paper over.
 */
export function ensureSignedIn(): Promise<User> {
  return new Promise((resolve, reject) => {
    const unsubscribe = onAuthStateChanged(
      auth,
      (user) => {
        unsubscribe()
        if (user) resolve(user)
        else reject(new Error('Not signed in'))
      },
      reject,
    )
  })
}
