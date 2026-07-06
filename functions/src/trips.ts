import { getFirestore } from 'firebase-admin/firestore'
import { HttpsError, onCall } from 'firebase-functions/https'
import { tripSchema, type Trip } from '@rv/shared'

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
      name: 'New Trip',
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

  await db
    .collection('trips')
    .doc(tripId)
    .collection('members')
    .doc(uid)
    .set({ joinedAt: new Date().toISOString() })

  return { tripId }
}

export const createTrip = onCall(async (request) => {
  if (!request.auth) {
    throw new HttpsError('unauthenticated', 'Must be signed in')
  }
  return createTripForUser(request.auth.uid)
})

export const joinTrip = onCall(async (request) => {
  if (!request.auth) {
    throw new HttpsError('unauthenticated', 'Must be signed in')
  }
  const shareCode = request.data?.shareCode
  if (typeof shareCode !== 'string' || shareCode.trim().length !== 6) {
    throw new HttpsError('invalid-argument', 'shareCode must be 6 characters')
  }
  return joinTripByCode(request.auth.uid, shareCode)
})
