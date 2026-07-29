import { HttpsError, onCall } from 'firebase-functions/https'
import { computeCorridorReconciliation } from './corridorReconciliation.js'
import { googleRoutesApiKey } from './routesApi.js'

/**
 * "Review changes" before anything writes (phase 4a): runs the exact same
 * reconciliation computation runReconcileCorridor will, but only ever reads
 * — no busy guard needed, since nothing is written and a stale preview by
 * the time of the real commit is a normal, harmless race (the commit path
 * re-validates pacing from scratch regardless).
 */
export const previewReconcileCorridor = onCall(
  { secrets: [googleRoutesApiKey] },
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
    const { changes } = await computeCorridorReconciliation(tripId, newStopOrder)
    return { changes }
  },
)
