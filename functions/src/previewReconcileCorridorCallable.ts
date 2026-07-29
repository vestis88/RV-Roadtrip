import { HttpsError, onCall } from 'firebase-functions/https'
import { computeCorridorReconciliation } from './corridorReconciliation.js'
import { googleRoutesApiKey } from './routesApi.js'
import { googlePlacesApiKey } from './placesApi.js'
import { claudeApiKey } from './prompts/planTrip.js'

/**
 * "Review changes" before anything writes (phase 4a, extended in phase 4b to
 * cover add/remove too): runs the exact same reconciliation computation
 * runReconcileCorridor will, but only ever reads — no busy guard needed,
 * since nothing is written and a stale preview by the time of the real
 * commit is a normal, harmless race (the commit path re-validates pacing
 * from scratch regardless). Needs Claude/Places secrets too now: reconciling
 * in a newly-added stop runs the detail phase and Places enrichment even for
 * a preview, since the traveler needs to see the real generated day (not a
 * placeholder) before deciding to confirm.
 */
export const previewReconcileCorridor = onCall(
  { secrets: [googleRoutesApiKey, claudeApiKey, googlePlacesApiKey] },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError('unauthenticated', 'Must be signed in')
    }
    const tripId = request.data?.tripId
    const newStopOrder = request.data?.newStopOrder
    if (
      typeof tripId !== 'string' ||
      !Array.isArray(newStopOrder) ||
      !newStopOrder.every((id) => typeof id === 'string')
    ) {
      throw new HttpsError(
        'invalid-argument',
        'tripId and newStopOrder (string[]) are required',
      )
    }
    const { changes, removedStopNames, addedDays, endDateChange } =
      await computeCorridorReconciliation(tripId, newStopOrder)
    return { changes, removedStopNames, addedDays, endDateChange }
  },
)
