import { initializeApp } from 'firebase-admin/app'
import { getFirestore } from 'firebase-admin/firestore'
import { beforeAll, describe, expect, it } from 'vitest'
import { sharedTripViewSchema } from '@rv/shared'
import { createTripForUser } from './trips.js'
import {
  createShareTokenForTrip,
  revokeShareTokensForTrip,
} from './shareTokens.js'
import { loadSharedTripView, viewSharedTrip } from './viewSharedTrip.js'

const PROJECT_ID = 'demo-rv-trip-planner'

beforeAll(() => {
  initializeApp({ projectId: PROJECT_ID })
  getFirestore().settings({ ignoreUndefinedProperties: true })
})

/** A trip with one day, its places, a corridor stop and one diary entry. */
async function seedTrip(uid: string) {
  const { tripId, shareCode } = await createTripForUser(uid)
  const tripRef = getFirestore().collection('trips').doc(tripId)

  await tripRef.update({ 'meta.name': 'Oslo to Rome 2026' })

  const dayRef = tripRef.collection('days').doc()
  await dayRef.set({
    index: 0,
    date: '2026-07-10',
    type: 'drive',
    overnight: {
      name: 'Lillehammer Camping',
      lat: 61.1153,
      lng: 10.4662,
      country: 'NO',
    },
    drive: {
      fromName: 'Oslo',
      toName: 'Lillehammer',
      distanceKm: 180,
      durationMin: 150,
      slot: 'morning',
    },
    summary: 'Easy first day north along the Mjøsa lake.',
  })

  const activityRef = dayRef.collection('activities').doc()
  await activityRef.set({
    name: 'Maihaugen Open-Air Museum',
    category: 'museum',
    lat: 61.1147,
    lng: 10.4726,
    blurb: 'A hidden-gem open-air museum the kids will love.',
    kidFriendly: true,
    status: 'selected',
  })
  await dayRef.collection('activities').doc().set({
    name: 'Hidden reserve activity',
    category: 'other',
    lat: 61.1,
    lng: 10.4,
    blurb: 'Only used to refill the pool.',
    kidFriendly: true,
    status: 'suggested',
    reserve: true,
  })
  await dayRef.collection('activities').doc().set({
    name: 'Dismissed activity',
    category: 'other',
    lat: 61.2,
    lng: 10.5,
    blurb: 'The travelers said no thanks.',
    kidFriendly: true,
    status: 'skipped',
  })
  await dayRef.collection('restaurants').doc().set({
    name: 'Bryggerikjelleren',
    meal: 'dinner',
    lat: 61.1123,
    lng: 10.4661,
    blurb: 'Cozy cellar restaurant near the river.',
    status: 'suggested',
  })

  await tripRef.collection('corridorStops').doc().set({
    name: 'Lillehammer',
    lat: 61.1153,
    lng: 10.4662,
    country: 'NO',
    status: 'committed',
    linkedDayIds: [dayRef.id],
  })
  // A suggestion the travelers turned down. It stays in Firestore so a later
  // refresh doesn't propose it again, and must not reach the share payload —
  // guests have no way to see it, and it is not part of the trip.
  await tripRef.collection('corridorStops').doc().set({
    name: 'Hamar',
    lat: 60.7945,
    lng: 11.0679,
    country: 'NO',
    status: 'rejected',
    linkedDayIds: [],
  })

  await tripRef.collection('log').doc().set({
    date: '2026-07-10',
    refType: 'activity',
    refPath: activityRef.path,
    note: 'Kids loved the Viking exhibit.',
    createdAt: '2026-07-10T18:00:00Z',
  })

  return { tripId, shareCode, dayId: dayRef.id }
}

interface FakeResponse {
  statusCode: number
  headers: Record<string, string>
  body: unknown
}

/** onRequest hands the raw Express req/res to the handler; these are the only
 * parts of that surface viewSharedTrip touches. */
type HttpHandler = (req: unknown, res: unknown) => void | Promise<void>

async function callEndpoint(
  query: Record<string, string>,
  method = 'GET',
): Promise<FakeResponse> {
  const captured: FakeResponse = { statusCode: 0, headers: {}, body: undefined }
  const response = {
    set(key: string, value: string) {
      captured.headers[key] = value
      return response
    },
    status(code: number) {
      captured.statusCode = code
      return response
    },
    json(body: unknown) {
      captured.body = body
      return response
    },
    send(body: unknown) {
      captured.body = body
      return response
    },
  }
  await (viewSharedTrip as unknown as HttpHandler)({ method, query }, response)
  return captured
}

describe('loadSharedTripView', () => {
  it('returns the plan and diary a guest needs to follow along', async () => {
    const { tripId } = await seedTrip('uidSharedViewA')
    const { token } = await createShareTokenForTrip('uidSharedViewA', tripId)

    const view = await loadSharedTripView(token)

    expect(view).not.toBeNull()
    expect(view!.trip.name).toBe('Oslo to Rome 2026')
    expect(view!.days).toHaveLength(1)
    expect(view!.days[0].summary).toBe(
      'Easy first day north along the Mjøsa lake.',
    )
    expect(view!.days[0].drive?.distanceKm).toBe(180)
    expect(view!.days[0].activities.map((place) => place.name)).toEqual([
      'Maihaugen Open-Air Museum',
    ])
    expect(view!.days[0].restaurants.map((place) => place.meal)).toEqual([
      'dinner',
    ])
    // Only the real route: the rejected stop seeded above is left out of the
    // payload entirely rather than sent for the view to filter.
    expect(view!.corridorStops.map((stop) => stop.name)).toEqual([
      'Lillehammer',
    ])
    expect(view!.diary).toHaveLength(1)
    // Resolved server-side: refPath points at a document no guest can read.
    expect(view!.diary[0].placeName).toBe('Maihaugen Open-Air Museum')
    expect(view!.diary[0].note).toBe('Kids loved the Viking exhibit.')
    expect(sharedTripViewSchema.safeParse(view).success).toBe(true)
  })

  it('leaves out reserve and skipped places, which are not part of the trip', async () => {
    const { tripId } = await seedTrip('uidSharedViewFilter')
    const { token } = await createShareTokenForTrip('uidSharedViewFilter', tripId)

    const view = await loadSharedTripView(token)

    const names = view!.days[0].activities.map((place) => place.name)
    expect(names).not.toContain('Hidden reserve activity')
    expect(names).not.toContain('Dismissed activity')
  })

  it('never exposes the editor share code, which would grant full edit access', async () => {
    const { tripId, shareCode } = await seedTrip('uidSharedViewSecret')
    const { token } = await createShareTokenForTrip('uidSharedViewSecret', tripId)

    const view = await loadSharedTripView(token)

    const serialized = JSON.stringify(view)
    expect(serialized).not.toContain(shareCode)
    expect(serialized).not.toContain('shareCode')
  })

  it('does not resolve a diary refPath pointing outside the shared trip', async () => {
    const { tripId } = await seedTrip('uidSharedViewCrossTrip')
    const other = await seedTrip('uidSharedViewCrossTripOther')
    const otherActivity = await getFirestore()
      .collection('trips')
      .doc(other.tripId)
      .collection('days')
      .doc(other.dayId)
      .collection('activities')
      .limit(1)
      .get()
    await getFirestore()
      .collection('trips')
      .doc(tripId)
      .collection('log')
      .doc()
      .set({
        date: '2026-07-11',
        refType: 'activity',
        refPath: otherActivity.docs[0].ref.path,
        note: 'Pointed at another trip.',
        createdAt: '2026-07-11T18:00:00Z',
      })
    const { token } = await createShareTokenForTrip(
      'uidSharedViewCrossTrip',
      tripId,
    )

    const view = await loadSharedTripView(token)

    const leaked = view!.diary.find((entry) => entry.date === '2026-07-11')
    expect(leaked?.placeName).toBe('A stop on the trip')
  })

  it('returns null for an unknown, revoked or deleted-trip token', async () => {
    const { tripId } = await seedTrip('uidSharedViewGone')
    const { token } = await createShareTokenForTrip('uidSharedViewGone', tripId)

    await expect(loadSharedTripView('a'.repeat(43))).resolves.toBeNull()

    await revokeShareTokensForTrip('uidSharedViewGone', tripId)
    await expect(loadSharedTripView(token)).resolves.toBeNull()
  })
})

describe('viewSharedTrip endpoint', () => {
  it('serves the view with permissive CORS and no caching', async () => {
    const { tripId } = await seedTrip('uidSharedEndpointA')
    const { token } = await createShareTokenForTrip('uidSharedEndpointA', tripId)

    const response = await callEndpoint({ token })

    expect(response.statusCode).toBe(200)
    expect(response.headers['Access-Control-Allow-Origin']).toBe('*')
    // A cached response would keep serving a trip that has moved on, and
    // would outlive a revoked link.
    expect(response.headers['Cache-Control']).toBe('no-store')
    expect(sharedTripViewSchema.safeParse(response.body).success).toBe(true)
  })

  it('never puts the editor share code on the wire', async () => {
    const { tripId, shareCode } = await seedTrip('uidSharedEndpointSecret')
    const { token } = await createShareTokenForTrip(
      'uidSharedEndpointSecret',
      tripId,
    )

    const response = await callEndpoint({ token })

    expect(JSON.stringify(response.body)).not.toContain(shareCode)
    expect(JSON.stringify(response.body)).not.toContain('shareCode')
  })

  it('404s an unknown token', async () => {
    const response = await callEndpoint({ token: 'b'.repeat(43) })
    expect(response.statusCode).toBe(404)
    expect(response.body).toEqual({ error: 'not-found' })
  })

  it('404s a revoked token, indistinguishably from an unknown one', async () => {
    const { tripId } = await seedTrip('uidSharedEndpointRevoked')
    const { token } = await createShareTokenForTrip(
      'uidSharedEndpointRevoked',
      tripId,
    )
    await revokeShareTokensForTrip('uidSharedEndpointRevoked', tripId)

    const response = await callEndpoint({ token })

    expect(response.statusCode).toBe(404)
    expect(response.body).toEqual({ error: 'not-found' })
  })

  it('rejects a request with no token at all', async () => {
    const response = await callEndpoint({})
    expect(response.statusCode).toBe(400)
  })

  it('answers a CORS preflight and refuses anything but GET', async () => {
    expect((await callEndpoint({}, 'OPTIONS')).statusCode).toBe(204)
    expect((await callEndpoint({}, 'POST')).statusCode).toBe(405)
  })
})
