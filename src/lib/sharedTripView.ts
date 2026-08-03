import type { SharedTripView } from '@rv/shared'

// Must match the region pinned in functions/src/globalOptions.ts — an
// onRequest function's URL embeds its region, so a mismatch 404s every fetch.
const FUNCTIONS_REGION = 'europe-west1'

const PROJECT_ID =
  (import.meta.env.VITE_FIREBASE_PROJECT_ID as string | undefined) ??
  'demo-rv-trip-planner'

/**
 * Assembled here rather than through src/lib/firebase.ts's `functions`
 * instance on purpose: viewSharedTrip is a plain HTTPS endpoint, not a
 * callable, precisely so a relative opening a share link needs no Firebase
 * SDK, no anonymous sign-in and no Firestore listener — just a URL. Routing
 * it through the callable SDK would quietly reintroduce the auth dependency
 * this whole feature exists to avoid.
 */
function endpointUrl(token: string): string {
  const base =
    import.meta.env.VITE_USE_FIREBASE_EMULATORS === 'true'
      ? `http://127.0.0.1:5001/${PROJECT_ID}/${FUNCTIONS_REGION}`
      : `https://${FUNCTIONS_REGION}-${PROJECT_ID}.cloudfunctions.net`
  return `${base}/viewSharedTrip?token=${encodeURIComponent(token)}`
}

/**
 * How often the open guest page re-reads the trip. The endpoint reads live
 * data on every request, so this interval is the whole of "the view updates
 * automatically" — long enough that a page left open all day is a trivial
 * load, short enough that a relative watching while the travelers log a stop
 * sees it appear without touching anything.
 */
export const SHARED_TRIP_POLL_MS = 30_000

/** The link the owner hands out, as opened in a browser. */
export function shareViewUrl(token: string): string {
  return `${window.location.origin}/share/${token}`
}

/** Null means the link is unknown or has been revoked. */
export async function fetchSharedTripView(
  token: string,
  signal?: AbortSignal,
): Promise<SharedTripView | null> {
  const response = await fetch(endpointUrl(token), { signal })
  if (response.status === 404) return null
  if (!response.ok) {
    throw new Error(`viewSharedTrip responded ${response.status}`)
  }
  return (await response.json()) as SharedTripView
}
