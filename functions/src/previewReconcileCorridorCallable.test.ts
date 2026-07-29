import { getFirestore } from 'firebase-admin/firestore'
import { initializeApp } from 'firebase-admin/app'
import { beforeAll, describe, expect, it } from 'vitest'
import { createTripForUser } from './trips.js'
import type { CorridorStop, TripDay } from '@rv/shared'

const PROJECT_ID = 'demo-rv-trip-planner'

beforeAll(() => {
  initializeApp({ projectId: PROJECT_ID })
  getFirestore().settings({ ignoreUndefinedProperties: true })
})

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

describe('previewReconcileCorridor (computeCorridorReconciliation, the resolver it delegates to)', () => {
  it('computes a diff without writing anything to Firestore', async () => {
    const db = getFirestore()
    const { tripId } = await createTripForUser('uidPreviewA')
    const tripRef = db.collection('trips').doc(tripId)
    await tripRef.update({
      'settings.startPoint': { name: 'Oslo', lat: 59.91, lng: 10.75 },
      'settings.endPoint': { name: 'Otta', lat: 61.77, lng: 9.54 },
      'settings.maxDriveHoursPerDay': 8,
    })

    const aRef = tripRef.collection('days').doc()
    await aRef.set(driveDay(0, '2026-07-10', 'Lillehammer', 61.11, 10.47))
    const bRef = tripRef.collection('days').doc()
    await bRef.set(driveDay(1, '2026-07-11', 'Otta', 61.77, 9.54))

    const aStopRef = tripRef.collection('corridorStops').doc()
    await aStopRef.set({
      name: 'Lillehammer',
      lat: 61.11,
      lng: 10.47,
      country: 'NO',
      status: 'committed',
      linkedDayIds: [aRef.id],
    } satisfies CorridorStop)
    const bStopRef = tripRef.collection('corridorStops').doc()
    await bStopRef.set({
      name: 'Otta',
      lat: 61.77,
      lng: 9.54,
      country: 'NO',
      status: 'committed',
      linkedDayIds: [bRef.id],
    } satisfies CorridorStop)

    const { computeCorridorReconciliation } = await import(
      './corridorReconciliation.js'
    )
    const { changes } = await computeCorridorReconciliation(tripId, [
      bStopRef.id,
      aStopRef.id,
    ])
    expect(changes.length).toBe(2)

    // Nothing was written — a preview never mutates the days it describes.
    const daysSnap = await tripRef.collection('days').orderBy('date').get()
    expect(daysSnap.docs.map((d) => d.data().date)).toEqual([
      '2026-07-10',
      '2026-07-11',
    ])
    expect(daysSnap.docs.map((d) => d.data().overnight.name)).toEqual([
      'Lillehammer',
      'Otta',
    ])
    expect((await tripRef.get()).data()?.planMeta.status).toBe('idle')
  })
})
