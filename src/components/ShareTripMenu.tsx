import { useState } from 'react'
import type { Trip } from '@rv/shared'
import { createTripShareLink, revokeTripShareLink } from '../lib/shareLink'
import { shareViewUrl } from '../lib/sharedTripView'

/** Resolves to the text to show for hand-copying, or null when the clipboard
 * accepted it. Clipboard access is refused outright in some contexts
 * (insecure origin, older browsers, denied permission) — the button silently
 * never flipped to "Copied!", which is indistinguishable from it still
 * working, so the caller shows the link to copy by hand instead. */
async function copyToClipboard(text: string): Promise<string | null> {
  try {
    await navigator.clipboard.writeText(text)
    return null
  } catch (error) {
    console.error('Failed to copy link', error)
    return text
  }
}

export function ShareTripMenu({ tripId, trip }: { tripId: string; trip: Trip }) {
  const [linkCopied, setLinkCopied] = useState(false)
  const [copyError, setCopyError] = useState<string | null>(null)
  const [joinCodeDraft, setJoinCodeDraft] = useState('')
  const [viewLink, setViewLink] = useState<string | null>(null)
  const [viewLinkCopied, setViewLinkCopied] = useState(false)
  const [viewLinkBusy, setViewLinkBusy] = useState(false)
  const [viewLinkError, setViewLinkError] = useState<string | null>(null)

  async function copyShareLink() {
    if (!trip.meta.shareCode) return
    const url = `${window.location.origin}${window.location.pathname}?join=${trip.meta.shareCode}`
    setCopyError(await copyToClipboard(url))
    setLinkCopied(true)
    setTimeout(() => setLinkCopied(false), 2000)
  }

  // Reuses the exact ?join= flow useTripSession already handles on mount
  // (and that the URL-param path is already E2E-tested against) rather
  // than duplicating the joinTrip callable logic here — this is just a
  // friendlier way to trigger it than hand-typing a URL.
  function submitJoinCode(event: React.FormEvent) {
    event.preventDefault()
    const code = joinCodeDraft.trim()
    if (!code) return
    const url = new URL(window.location.href)
    url.searchParams.set('join', code)
    window.location.href = url.toString()
  }

  async function runViewLinkAction(action: () => Promise<string | null>) {
    setViewLinkBusy(true)
    setViewLinkError(null)
    try {
      setViewLink(await action())
    } catch (error) {
      console.error('View-only link action failed', error)
      setViewLinkError('Could not reach the server — please try again.')
    } finally {
      setViewLinkBusy(false)
    }
  }

  async function showViewLink(): Promise<string> {
    return shareViewUrl(await createTripShareLink(tripId))
  }

  /** Revoke first, so the old link is dead the moment a new one exists —
   * "regenerate" is what an owner reaches for when a link has spread further
   * than they meant it to. */
  async function regenerateViewLink(): Promise<string> {
    await revokeTripShareLink(tripId)
    return showViewLink()
  }

  async function revokeViewLink(): Promise<null> {
    await revokeTripShareLink(tripId)
    return null
  }

  async function copyViewLink() {
    if (!viewLink) return
    const uncopied = await copyToClipboard(viewLink)
    // Unlike the editor code's copy button, the link itself is already on
    // screen here, so a refused clipboard needs no fallback beyond saying so.
    setViewLinkError(
      uncopied ? "Couldn't copy — select the link above instead." : null,
    )
    if (uncopied) return
    setViewLinkCopied(true)
    setTimeout(() => setViewLinkCopied(false), 2000)
  }

  return (
    <details className="mx-auto max-w-xs text-center" data-testid="share-menu">
      <summary
        data-testid="share-menu-toggle"
        className="link inline-block cursor-pointer py-2 text-sm"
      >
        Share / join trip
      </summary>
      <div className="mt-2 space-y-4">
        <div className="space-y-2">
          {trip.meta.shareCode && (
            <>
              <div className="flex items-center justify-center gap-2">
                <p
                  className="text-sm text-neutral-500 dark:text-neutral-400"
                  data-testid="share-code"
                >
                  Share code: {trip.meta.shareCode}
                </p>
                <button
                  type="button"
                  data-testid="copy-share-link"
                  onClick={() => copyShareLink().catch(console.error)}
                  className="btn btn-secondary"
                >
                  {linkCopied ? 'Copied!' : 'Copy link'}
                </button>
              </div>
              <p className="text-xs text-neutral-500 dark:text-neutral-400">
                Anyone with this code can edit the trip — use it for the people
                travelling with you.
              </p>
              {copyError && (
                <p
                  data-testid="share-link-copy-error"
                  className="text-xs text-red-600 dark:text-red-400"
                >
                  Couldn't copy automatically — copy this link: {copyError}
                </p>
              )}
            </>
          )}
          <form
            onSubmit={submitJoinCode}
            className="flex items-center justify-center gap-2"
          >
            <input
              className="field field-sm max-w-40 text-center"
              data-testid="join-code-input"
              placeholder="Enter a share code"
              value={joinCodeDraft}
              onChange={(event) => setJoinCodeDraft(event.target.value)}
            />
            <button
              type="submit"
              data-testid="join-code-submit"
              className="btn btn-secondary"
            >
              Join
            </button>
          </form>
        </div>

        {/* Visually its own panel, not another line in the list above: the
            two things look alike (both "a thing you send someone") but differ
            in exactly the way that matters, so the distinction has to survive
            a hurried glance. */}
        <div
          className="card space-y-2 p-3"
          data-testid="family-share"
        >
          <p className="text-sm font-semibold text-neutral-900 dark:text-white">
            Share with family (view only)
          </p>
          <p className="text-xs text-neutral-500 dark:text-neutral-400">
            A page relatives can open without an account to follow the plan and
            the diary. They cannot change anything.
          </p>

          {viewLink ? (
            <>
              <p
                className="break-all text-xs text-neutral-700 dark:text-neutral-300"
                data-testid="view-only-link"
              >
                {viewLink}
              </p>
              <div className="flex flex-wrap justify-center gap-2">
                <button
                  type="button"
                  data-testid="copy-view-link"
                  onClick={() => copyViewLink().catch(console.error)}
                  className="btn btn-sm btn-secondary"
                >
                  {viewLinkCopied ? 'Copied!' : 'Copy link'}
                </button>
                <button
                  type="button"
                  data-testid="regenerate-view-link"
                  disabled={viewLinkBusy}
                  onClick={() => void runViewLinkAction(regenerateViewLink)}
                  className="btn btn-sm btn-secondary"
                >
                  New link
                </button>
                <button
                  type="button"
                  data-testid="revoke-view-link"
                  disabled={viewLinkBusy}
                  onClick={() => void runViewLinkAction(revokeViewLink)}
                  className="btn btn-sm btn-danger-ghost"
                >
                  Turn off
                </button>
              </div>
            </>
          ) : (
            <button
              type="button"
              data-testid="create-view-link"
              disabled={viewLinkBusy}
              onClick={() => void runViewLinkAction(showViewLink)}
              className="btn btn-sm btn-primary"
            >
              {viewLinkBusy ? 'Working…' : 'Get view-only link'}
            </button>
          )}

          {viewLinkError && (
            <p data-testid="view-link-error" className="text-xs text-red-600 dark:text-red-400">
              {viewLinkError}
            </p>
          )}
        </div>
      </div>
    </details>
  )
}
