import { useState } from 'react'
import type { Trip } from '@rv/shared'

export function ShareTripMenu({ trip }: { trip: Trip }) {
  const [linkCopied, setLinkCopied] = useState(false)
  const [joinCodeDraft, setJoinCodeDraft] = useState('')

  async function copyShareLink() {
    if (!trip.meta.shareCode) return
    const url = `${window.location.origin}${window.location.pathname}?join=${trip.meta.shareCode}`
    try {
      await navigator.clipboard.writeText(url)
      setLinkCopied(true)
      setTimeout(() => setLinkCopied(false), 2000)
    } catch (error) {
      console.error('Failed to copy share link', error)
    }
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

  return (
    <details className="mx-auto max-w-xs text-center" data-testid="share-menu">
      <summary
        data-testid="share-menu-toggle"
        className="link inline-block cursor-pointer py-2 text-sm"
      >
        Share / join trip
      </summary>
      <div className="mt-2 space-y-2">
        {trip.meta.shareCode && (
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
    </details>
  )
}
