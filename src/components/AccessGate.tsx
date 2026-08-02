import { useEffect, useState } from 'react'
import {
  attachGoogleAccount,
  signOutOfApp,
  watchAccess,
  type AccessStatus,
} from '../lib/appAccess'

/**
 * Stands in front of the whole app. Nothing below it mounts — which is the
 * point: `useTripSession` creates a trip on first load, so rendering the
 * shell for an unrecognised visitor is what used to hand every passer-by
 * an account, a trip and a working "Generate plan" button.
 *
 * Deliberately renders nothing of the app's own chrome, and says as little
 * as possible to someone who isn't recognised: no trip names, no counts,
 * nothing about who the owner is.
 */
export function AccessGate({ children }: { children: React.ReactNode }) {
  const [status, setStatus] = useState<AccessStatus>({
    state: 'checking',
    hasAnonymousTrips: false,
  })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => watchAccess(setStatus), [])

  async function signIn() {
    setBusy(true)
    setError(null)
    try {
      await attachGoogleAccount()
    } catch (err) {
      console.error('Sign-in failed', err)
      setError('Could not sign in just now — please try again.')
    } finally {
      setBusy(false)
    }
  }

  if (status.state === 'granted') return <>{children}</>

  return (
    <div
      className="mx-auto flex min-h-svh max-w-md flex-col items-center justify-center gap-4 p-6 text-center"
      data-testid="access-gate"
    >
      <h1 className="heading-md">RV Road Trip Planner</h1>

      {status.state === 'checking' && (
        <p className="text-neutral-500 dark:text-neutral-400">Checking…</p>
      )}

      {status.state === 'signed-out' && (
        <>
          <p className="text-sm text-neutral-600 dark:text-neutral-300">
            {status.hasAnonymousTrips
              ? 'Sign in with Google to keep using this app. Your existing trips on this device stay exactly where they are.'
              : 'This planner is private. Sign in with the Google account it belongs to.'}
          </p>
          <button
            type="button"
            data-testid="access-sign-in"
            onClick={() => void signIn()}
            disabled={busy}
            className="btn btn-primary"
          >
            {busy ? 'Opening Google…' : 'Sign in with Google'}
          </button>
        </>
      )}

      {status.state === 'denied' && (
        <>
          <p
            className="text-sm text-neutral-600 dark:text-neutral-300"
            data-testid="access-denied"
          >
            This planner is private, and {status.email ?? 'that account'} isn’t on
            its guest list.
          </p>
          <button
            type="button"
            data-testid="access-sign-out"
            onClick={() => void signOutOfApp()}
            className="btn btn-secondary"
          >
            Try a different account
          </button>
        </>
      )}

      {error && (
        <p className="text-sm text-red-600 dark:text-red-400" data-testid="access-error">
          {error}
        </p>
      )}
    </div>
  )
}
