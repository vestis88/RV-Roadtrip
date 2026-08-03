import { initializeApp } from 'firebase/app'
import {
  connectAuthEmulator,
  getAuth,
  GoogleAuthProvider,
  onAuthStateChanged,
  signInWithCredential,
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

  /**
   * Sign-in hook for the E2E suite, and the one thing in it that isn't the
   * real flow.
   *
   * The gate's own button calls signInWithPopup, which in the emulator
   * opens Firebase's sign-in widget in a second window. Driving that
   * widget's markup from ~90 specs is both slow and tied to whatever
   * firebase-tools version is installed, so the suite skips it: the Auth
   * emulator accepts an UNSIGNED Google id_token supplied as plain JSON,
   * and the ID token it mints from one is identical to the real flow's in
   * the two respects that matter — sign_in_provider is google.com and
   * email_verified is true, which is exactly what claimAccess checks.
   *
   * Everything downstream is genuine: AccessGate's watchAccess, the
   * claimAccess callable, the config/allowlist document, the custom claim,
   * the forced token refresh and firestore.rules' hasAccess(). Only
   * Google's own popup is stubbed out, and access-gate.spec.ts covers the
   * button that opens it separately.
   *
   * None of this reaches production. Vite inlines import.meta.env at build
   * time, so with the flag unset this whole block is `if (undefined ===
   * 'true')` and the minifier drops it — along with the two imports above
   * that nothing else references.
   */
  ;(
    window as unknown as { __e2eSignIn?: (email: string) => Promise<void> }
  ).__e2eSignIn = async (email: string) => {
    await signInWithCredential(
      auth,
      GoogleAuthProvider.credential(
        JSON.stringify({ sub: `e2e|${email}`, email, email_verified: true }),
      ),
    )
  }
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
