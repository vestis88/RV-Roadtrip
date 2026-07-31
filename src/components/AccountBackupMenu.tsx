import { useEffect, useState } from 'react'
import { onAuthStateChanged, type AuthError, type User } from 'firebase/auth'
import { auth } from '../lib/firebase'
import {
  completePendingGoogleLinkRedirect,
  linkGoogleAccount,
  type LinkGoogleResult,
} from '../lib/accountBackup'

function googleEmail(user: User | null): string | null {
  return (
    user?.providerData.find((p) => p.providerId === 'google.com')?.email ?? null
  )
}

/** The one error code here worth a distinct message: it means the Google
 * sign-in provider itself isn't turned on for this Firebase project (an
 * admin/console setting, not something a retry ever fixes) — see
 * master_plan.md's account-linking entry for the one-time console step. */
function describeLinkError(error: unknown): string {
  const code = (error as AuthError | undefined)?.code
  if (code === 'auth/operation-not-allowed') {
    return "Google sign-in isn't enabled for this app yet. Try again later, or let the trip owner know."
  }
  return 'Could not link Google account. Please try again.'
}

export function AccountBackupMenu() {
  const [user, setUser] = useState<User | null>(auth.currentUser)
  const [linking, setLinking] = useState(false)
  const [errorMessage, setErrorMessage] = useState('')

  function handleResult(result: LinkGoogleResult) {
    if (result.status === 'merged') {
      // The uid this whole app is keyed on (useTripSession's uid,
      // useMyTrips, every localStorage read) just changed underneath us —
      // a reload is the simplest way to land every hook consistently on
      // the new identity, same tradeoff already made for a deployed
      // service-worker update (see main.tsx).
      window.location.reload()
    }
  }

  useEffect(() => onAuthStateChanged(auth, setUser), [])

  // Finishes a link that fell back to a full-page redirect (mobile Safari,
  // especially a standalone/home-screen PWA, frequently can't complete an
  // OAuth popup) — a no-op on every load that isn't that return trip.
  useEffect(() => {
    completePendingGoogleLinkRedirect()
      .then((result) => {
        if (result) handleResult(result)
      })
      .catch((error: unknown) => {
        console.error('Google account link (redirect) failed', error)
        setErrorMessage(describeLinkError(error))
      })
  }, [])

  const linkedEmail = googleEmail(user)

  async function handleLink() {
    setLinking(true)
    setErrorMessage('')
    try {
      const result = await linkGoogleAccount()
      handleResult(result)
      // 'redirecting' navigates the page away before this line would ever
      // run; 'linked'/'cancelled' just need the button re-enabled.
      setLinking(false)
    } catch (error) {
      console.error('Google account link failed', error)
      setErrorMessage(describeLinkError(error))
      setLinking(false)
    }
  }

  return (
    <details className="mx-auto max-w-xs text-center" data-testid="account-backup-menu">
      <summary
        data-testid="account-backup-toggle"
        className="link inline-block cursor-pointer py-2 text-sm"
      >
        Back up your trips
      </summary>
      <div className="mt-2 space-y-2">
        {linkedEmail ? (
          <p
            className="text-sm text-neutral-500 dark:text-neutral-400"
            data-testid="account-backup-linked"
          >
            Backed up with {linkedEmail}
          </p>
        ) : (
          <>
            <p className="text-sm text-neutral-500 dark:text-neutral-400">
              This device&apos;s trips only exist here. Link a Google account
              so you can recover them if you clear your browser or switch
              devices.
            </p>
            <button
              type="button"
              data-testid="account-backup-link"
              onClick={() => handleLink().catch(console.error)}
              disabled={linking}
              className="btn btn-secondary"
            >
              {linking ? 'Linking…' : 'Back up with Google'}
            </button>
            {errorMessage && (
              <p className="text-sm text-red-600" data-testid="account-backup-error">
                {errorMessage}
              </p>
            )}
          </>
        )}
      </div>
    </details>
  )
}
