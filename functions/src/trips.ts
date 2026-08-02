import { getFirestore } from 'firebase-admin/firestore'
import { HttpsError, onCall } from 'firebase-functions/https'
import { tripSchema, type Trip } from '@rv/shared'
import { requireAccess } from './accessControl.js'

const SHARE_CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'

function randomShareCode(): string {
  let code = ''
  for (let i = 0; i < 6; i++) {
    code += SHARE_CODE_CHARS[Math.floor(Math.random() * SHARE_CODE_CHARS.length)]
  }
  return code
}

function defaultTrip(): Trip {
  const now = new Date()
  const in14Days = new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000)
  return {
    meta: {
      // Blank, not a placeholder like 'New Trip' — the name field on Trip
      // setup should read as genuinely empty and ready to type into, not as
      // text the traveler has to notice and clear first.
      name: '',
      shareCode: '', // overwritten by caller once a unique code is picked
      createdAt: now.toISOString(),
      version: 1,
    },
    settings: {
      startDate: now.toISOString().slice(0, 10),
      endDate: in14Days.toISOString().slice(0, 10),
      startPoint: { name: '', lat: 0, lng: 0 },
      endPoint: { name: '', lat: 0, lng: 0 },
      travelers: [],
      interests: [],
      preferredCountries: [],
      restDayFrequency: 7,
      maxDriveHoursPerDay: 4,
      vehicle: {
        type: 'RV',
        weightKg: 3500,
        registeredAs: 'car',
        lengthM: 7.39,
        heightM: 3.04,
        widthM: 2.38,
        fuel: 'diesel',
      },
    },
    notes: { freeText: '', updatedAt: now.toISOString() },
    planMeta: { status: 'idle' },
  }
}

export async function createTripForUser(uid: string) {
  const db = getFirestore()
  const tripRef = db.collection('trips').doc()

  let shareCode = ''
  for (let attempt = 0; attempt < 5; attempt++) {
    const candidate = randomShareCode()
    const existing = await db.collection('shareCodes').doc(candidate).get()
    if (!existing.exists) {
      shareCode = candidate
      break
    }
  }
  if (!shareCode) {
    throw new HttpsError(
      'resource-exhausted',
      'Could not allocate a unique share code',
    )
  }

  const trip = defaultTrip()
  trip.meta.shareCode = shareCode
  tripSchema.parse(trip)

  const now = new Date().toISOString()
  await db.runTransaction(async (tx) => {
    tx.set(tripRef, trip)
    tx.set(tripRef.collection('members').doc(uid), { joinedAt: now })
    tx.set(db.collection('shareCodes').doc(shareCode), { tripId: tripRef.id })
    // Reverse index for "my trips": membership itself only lives as
    // trips/{tripId}/members/{uid}, which a client can't query across trips
    // (no collection-group rule for it, and it'd need one per trip anyway).
    // This mirrors it the other direction so a client can list its own
    // trips with a single query instead of needing a trip's ID already.
    tx.set(db.collection('users').doc(uid).collection('trips').doc(tripRef.id), {
      joinedAt: now,
    })
  })

  return { tripId: tripRef.id, shareCode }
}

export async function joinTripByCode(uid: string, rawShareCode: string) {
  const shareCode = rawShareCode.trim().toUpperCase()
  const db = getFirestore()
  const codeDoc = await db.collection('shareCodes').doc(shareCode).get()
  if (!codeDoc.exists) {
    throw new HttpsError('not-found', 'Invalid share code')
  }
  const { tripId } = codeDoc.data() as { tripId: string }

  const now = new Date().toISOString()
  const batch = db.batch()
  batch.set(db.collection('trips').doc(tripId).collection('members').doc(uid), {
    joinedAt: now,
  })
  // Same reverse index as createTripForUser — joining by code needs to land
  // in "my trips" too, not just grant access.
  batch.set(db.collection('users').doc(uid).collection('trips').doc(tripId), {
    joinedAt: now,
  })
  await batch.commit()

  return { tripId }
}

export const createTrip = onCall(async (request) => {
  if (!request.auth) {
    throw new HttpsError('unauthenticated', 'Must be signed in')
  }
  requireAccess(request.auth)
  return createTripForUser(request.auth.uid)
})

export const joinTrip = onCall(async (request) => {
  if (!request.auth) {
    throw new HttpsError('unauthenticated', 'Must be signed in')
  }
  requireAccess(request.auth)
  const shareCode = request.data?.shareCode
  if (typeof shareCode !== 'string' || shareCode.trim().length !== 6) {
    throw new HttpsError('invalid-argument', 'shareCode must be 6 characters')
  }
  return joinTripByCode(request.auth.uid, shareCode)
})
