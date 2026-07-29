import { getFirestore } from 'firebase-admin/firestore'
import { initializeApp } from 'firebase-admin/app'
import { beforeAll, describe, expect, it } from 'vitest'
import { createTripForUser } from './trips.js'
import {
  computeCorridorReconciliation,
  runReconcileCorridor,
} from './corridorReconciliation.js'
import type { CorridorStop, TripDay } from '@rv/shared'

const PROJECT_ID = 'demo-rv-trip-planner'

beforeAll(() => {
  initializeApp({ projectId: PROJECT_ID })
  getFirestore().settings({ ignoreUndefinedProperties: true })
})

async function waitFor<T>(
  fn: () => Promise<T | undefined>,
  timeoutMs = 15_000,
): Promise<T> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const result = await fn()
    if (result !== undefined) return result
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  throw new Error('Timed out waiting for condition')
}

function driveDay(index: number, date: string, name: string, lat: number, lng: number): TripDay {
  return {
    index,
    date,
    type: 'drive',
    overnight: { name, lat, lng, country: 'NO' },
    drive: {
      fromName: `Stop ${index - 1}`,
      toName: name,
      distanceKm: 100,
      durationMin: 90,
      slot: 'morning',
    },
    summary: `Day ${index} to ${name}`,
  }
}

/** Seeds a 3-stop trip: Lillehammer (0), Otta (1), Dombas (2), one day each,
 * with matching committed corridor stops. Returns the day and stop IDs. */
async function seedThreeStopTrip(uid: string) {
  const db = getFirestore()
  const { tripId } = await createTripForUser(uid)
  const tripRef = db.collection('trips').doc(tripId)

  await tripRef.update({
    'settings.startPoint': { name: 'Oslo', lat: 59.91, lng: 10.75 },
    'settings.endPoint': { name: 'Dombas', lat: 62.07, lng: 9.13 },
    'settings.maxDriveHoursPerDay': 8,
  })

  const stops = [
    { date: '2026-07-10', name: 'Lillehammer', lat: 61.11, lng: 10.47 },
    { date: '2026-07-11', name: 'Otta', lat: 61.77, lng: 9.54 },
    { date: '2026-07-12', name: 'Dombas', lat: 62.07, lng: 9.13 },
  ]

  const dayIds: string[] = []
  const stopIds: string[] = []
  for (const [i, s] of stops.entries()) {
    const dayRef = tripRef.collection('days').doc()
    await dayRef.set(driveDay(i, s.date, s.name, s.lat, s.lng))
    dayIds.push(dayRef.id)

    const stopRef = tripRef.collection('corridorStops').doc()
    await stopRef.set({
      name: s.name,
      lat: s.lat,
      lng: s.lng,
      country: 'NO',
      status: 'committed',
      linkedDayIds: [dayRef.id],
    } satisfies CorridorStop)
    stopIds.push(stopRef.id)
  }

  return { tripId, tripRef, dayIds, stopIds }
}

describe('computeCorridorReconciliation', () => {
  it('remaps dates/indexes when stops move, recomputing the arrival drive leg', async () => {
    const { tripId, dayIds, stopIds } = await seedThreeStopTrip('uidReconcileA')
    const [lillehammerId, ottaId, dombasId] = dayIds
    const [lillehammerStop, ottaStop, dombasStop] = stopIds

    // Swap Otta and Dombas: Lillehammer, Dombas, Otta.
    const { changes, writes } = await computeCorridorReconciliation(tripId, [
      lillehammerStop,
      dombasStop,
      ottaStop,
    ])

    // Lillehammer stays first — no change reported for it.
    expect(changes.find((c) => c.dayId === lillehammerId)).toBeUndefined()

    const dombasChange = changes.find((c) => c.dayId === dombasId)
    expect(dombasChange).toMatchObject({
      overnightName: 'Dombas',
      oldDate: '2026-07-12',
      newDate: '2026-07-11',
    })
    expect(dombasChange?.newDistanceKm).toBeGreaterThan(0)

    const ottaChange = changes.find((c) => c.dayId === ottaId)
    expect(ottaChange).toMatchObject({
      overnightName: 'Otta',
      oldDate: '2026-07-11',
      newDate: '2026-07-12',
    })

    const dombasWrite = writes.find((w) => w.op === 'set' && w.ref.id === dombasId)
    expect(dombasWrite).toBeDefined()
    const dombasData = dombasWrite && 'data' in dombasWrite ? (dombasWrite.data as TripDay) : undefined
    expect(dombasData?.drive?.fromName).toBe('Lillehammer')
    expect(dombasData?.drive?.toName).toBe('Dombas')
    expect(dombasData?.index).toBe(1)

    const ottaWrite = writes.find((w) => w.op === 'set' && w.ref.id === ottaId)
    const ottaData = ottaWrite && 'data' in ottaWrite ? (ottaWrite.data as TripDay) : undefined
    expect(ottaData?.drive?.fromName).toBe('Dombas')
    expect(ottaData?.drive?.toName).toBe('Otta')
    expect(ottaData?.index).toBe(2)
  })

  it('reports no changes when the order is unchanged', async () => {
    const { tripId, stopIds } = await seedThreeStopTrip('uidReconcileNoop')
    const { changes } = await computeCorridorReconciliation(tripId, stopIds)
    expect(changes).toEqual([])
  })

  it('rejects an order that adds, removes, or substitutes a stop', async () => {
    const { tripId, stopIds } = await seedThreeStopTrip('uidReconcileBadOrder')
    const [a, b] = stopIds

    // Missing the third stop.
    await expect(
      computeCorridorReconciliation(tripId, [a, b]),
    ).rejects.toThrow(/permutation/)

    // An unknown extra ID substituted in.
    await expect(
      computeCorridorReconciliation(tripId, [a, b, 'not-a-real-stop']),
    ).rejects.toThrow()
  })

  it('keeps a multi-day stop (e.g. a rest day) moving together as one block', async () => {
    const db = getFirestore()
    const { tripId } = await createTripForUser('uidReconcileMultiDay')
    const tripRef = db.collection('trips').doc(tripId)
    await tripRef.update({
      'settings.startPoint': { name: 'Oslo', lat: 59.91, lng: 10.75 },
      'settings.endPoint': { name: 'Dombas', lat: 62.07, lng: 9.13 },
      'settings.maxDriveHoursPerDay': 8,
    })

    const lillehammerRef = tripRef.collection('days').doc()
    await lillehammerRef.set(driveDay(0, '2026-07-10', 'Lillehammer', 61.11, 10.47))

    const ottaDriveRef = tripRef.collection('days').doc()
    await ottaDriveRef.set(driveDay(1, '2026-07-11', 'Otta', 61.77, 9.54))
    const ottaRestRef = tripRef.collection('days').doc()
    await ottaRestRef.set({
      index: 2,
      date: '2026-07-12',
      type: 'rest',
      overnight: { name: 'Otta', lat: 61.77, lng: 9.54, country: 'NO' },
      summary: 'Rest day in Otta',
    })

    const dombasRef = tripRef.collection('days').doc()
    await dombasRef.set(driveDay(3, '2026-07-13', 'Dombas', 62.07, 9.13))

    const lillehammerStopRef = tripRef.collection('corridorStops').doc()
    await lillehammerStopRef.set({
      name: 'Lillehammer',
      lat: 61.11,
      lng: 10.47,
      country: 'NO',
      status: 'committed',
      linkedDayIds: [lillehammerRef.id],
    } satisfies CorridorStop)

    const ottaStopRef = tripRef.collection('corridorStops').doc()
    await ottaStopRef.set({
      name: 'Otta',
      lat: 61.77,
      lng: 9.54,
      country: 'NO',
      status: 'committed',
      linkedDayIds: [ottaDriveRef.id, ottaRestRef.id],
    } satisfies CorridorStop)

    const dombasStopRef = tripRef.collection('corridorStops').doc()
    await dombasStopRef.set({
      name: 'Dombas',
      lat: 62.07,
      lng: 9.13,
      country: 'NO',
      status: 'committed',
      linkedDayIds: [dombasRef.id],
    } satisfies CorridorStop)

    // Move Dombas before Otta's rest-day pair.
    const { changes } = await computeCorridorReconciliation(tripId, [
      lillehammerStopRef.id,
      dombasStopRef.id,
      ottaStopRef.id,
    ])

    const dombasChange = changes.find((c) => c.dayId === dombasRef.id)
    expect(dombasChange).toMatchObject({ oldDate: '2026-07-13', newDate: '2026-07-11' })

    // Both Otta days moved back by 2, together, keeping the drive day before
    // the rest day.
    const ottaDriveChange = changes.find((c) => c.dayId === ottaDriveRef.id)
    const ottaRestChange = changes.find((c) => c.dayId === ottaRestRef.id)
    expect(ottaDriveChange?.newDate).toBe('2026-07-12')
    expect(ottaRestChange?.newDate).toBe('2026-07-13')
  })
})

describe('runReconcileCorridor', () => {
  it('commits the reorder and updates planMeta totals', async () => {
    const { tripId, tripRef, dayIds, stopIds } = await seedThreeStopTrip('uidReconcileCommit')
    const [, ottaId, dombasId] = dayIds
    const [lillehammerStop, ottaStop, dombasStop] = stopIds

    const changes = await runReconcileCorridor(tripId, [
      lillehammerStop,
      dombasStop,
      ottaStop,
    ])
    expect(changes.length).toBe(2)

    const [dombasSnap, ottaSnap] = await Promise.all([
      tripRef.collection('days').doc(dombasId).get(),
      tripRef.collection('days').doc(ottaId).get(),
    ])
    expect(dombasSnap.data()?.date).toBe('2026-07-11')
    expect(ottaSnap.data()?.date).toBe('2026-07-12')

    const trip = (await tripRef.get()).data()
    expect(trip?.planMeta.status).toBe('ready')
    expect(trip?.planMeta.totalKm).toBeGreaterThan(0)
  })

  it('leaves the trip untouched when the new order fails pacing validation', async () => {
    const db = getFirestore()
    const { tripId } = await createTripForUser('uidReconcilePacingFail')
    const tripRef = db.collection('trips').doc(tripId)
    // A max-drive-hours so tight that any real leg between these far-apart
    // points blows the tolerance once reordered to be non-adjacent.
    await tripRef.update({
      'settings.startPoint': { name: 'Oslo', lat: 59.91, lng: 10.75 },
      'settings.endPoint': { name: 'Rome', lat: 41.9, lng: 12.5 },
      'settings.maxDriveHoursPerDay': 0.01,
    })

    const aRef = tripRef.collection('days').doc()
    await aRef.set(driveDay(0, '2026-07-10', 'A', 59.91, 10.75))
    const bRef = tripRef.collection('days').doc()
    await bRef.set(driveDay(1, '2026-07-11', 'B', 45, 11))

    const aStopRef = tripRef.collection('corridorStops').doc()
    await aStopRef.set({
      name: 'A',
      lat: 59.91,
      lng: 10.75,
      country: 'NO',
      status: 'committed',
      linkedDayIds: [aRef.id],
    } satisfies CorridorStop)
    const bStopRef = tripRef.collection('corridorStops').doc()
    await bStopRef.set({
      name: 'B',
      lat: 45,
      lng: 11,
      country: 'IT',
      status: 'committed',
      linkedDayIds: [bRef.id],
    } satisfies CorridorStop)

    await expect(
      runReconcileCorridor(tripId, [bStopRef.id, aStopRef.id]),
    ).rejects.toThrow(/pacing validation failed/)

    const daysSnap = await tripRef.collection('days').orderBy('date').get()
    expect(daysSnap.docs.map((d) => d.data().date)).toEqual([
      '2026-07-10',
      '2026-07-11',
    ])
  })
})

describe('reconcileCorridor via the planRequests trigger', () => {
  it('runs end to end and shifts the reordered days', async () => {
    const db = getFirestore()
    const { tripId, tripRef, dayIds, stopIds } = await seedThreeStopTrip(
      'uidReconcileTrigger',
    )
    const [, ottaId, dombasId] = dayIds
    const [lillehammerStop, ottaStop, dombasStop] = stopIds

    const requestRef = await db.collection('planRequests').add({
      tripId,
      kind: 'reconcileCorridor',
      reconcileCorridorContext: {
        newStopOrder: [lillehammerStop, dombasStop, ottaStop],
      },
      status: 'pending',
    })

    await waitFor(async () => {
      const snap = await requestRef.get()
      return snap.data()?.status === 'done' ? snap.data() : undefined
    })

    const [dombasSnap, ottaSnap] = await Promise.all([
      tripRef.collection('days').doc(dombasId).get(),
      tripRef.collection('days').doc(ottaId).get(),
    ])
    expect(dombasSnap.data()?.date).toBe('2026-07-11')
    expect(ottaSnap.data()?.date).toBe('2026-07-12')
    expect((await tripRef.get()).data()?.planMeta.status).toBe('ready')
  }, 30_000)

  it('errors clearly when the request carries no reconcileCorridorContext', async () => {
    const db = getFirestore()
    const { tripId } = await seedThreeStopTrip('uidReconcileNoContext')

    const requestRef = await db.collection('planRequests').add({
      tripId,
      kind: 'reconcileCorridor',
      status: 'pending',
    })

    const request = await waitFor(async () => {
      const snap = await requestRef.get()
      return snap.data()?.status === 'error' ? snap.data() : undefined
    })
    expect(request?.error).toContain('reconcileCorridorContext')
  }, 30_000)

  it('is rejected by the cost guard while another plan operation is already running', async () => {
    const db = getFirestore()
    const { tripId, tripRef, stopIds } = await seedThreeStopTrip(
      'uidReconcileCostGuard',
    )
    await tripRef.update({ 'planMeta.status': 'generating' })

    const requestRef = await db.collection('planRequests').add({
      tripId,
      kind: 'reconcileCorridor',
      reconcileCorridorContext: { newStopOrder: [...stopIds].reverse() },
      status: 'pending',
    })

    const request = await waitFor(async () => {
      const snap = await requestRef.get()
      return snap.data()?.status === 'error' ? snap.data() : undefined
    })
    expect(request?.error).toContain('already in progress')

    const daysSnap = await tripRef.collection('days').orderBy('date').get()
    expect(daysSnap.docs.map((d) => d.data().date)).toEqual([
      '2026-07-10',
      '2026-07-11',
      '2026-07-12',
    ])
  }, 30_000)
})
