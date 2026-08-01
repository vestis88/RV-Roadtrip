import { getFirestore, type DocumentReference } from 'firebase-admin/firestore'
import { initializeApp } from 'firebase-admin/app'
import { beforeAll, describe, expect, it } from 'vitest'
import type { CorridorStop, TripDay } from '@rv/shared'
import { createTripForUser } from './trips.js'
import { buildCorridorStopWrites } from './corridorStops.js'
import { commitInChunks } from './firestoreBatch.js'

const PROJECT_ID = 'demo-rv-trip-planner'

beforeAll(() => {
  initializeApp({ projectId: PROJECT_ID })
  getFirestore().settings({ ignoreUndefinedProperties: true })
})

function day(overrides: Partial<TripDay> & { index: number }): TripDay {
  return {
    date: `2026-07-${String(10 + overrides.index).padStart(2, '0')}`,
    type: 'drive',
    overnight: { name: `Stop ${overrides.index}`, lat: 0, lng: 0, country: 'NO' },
    summary: '',
    ...overrides,
  }
}

describe('buildCorridorStopWrites', () => {
  it('produces one committed stop per distinct overnight location', async () => {
    const db = getFirestore()
    const { tripId } = await createTripForUser('uidCorridorSingle')
    const tripRef = db.collection('trips').doc(tripId)

    const dayRef = tripRef.collection('days').doc()
    const writtenDays = [
      {
        ref: dayRef,
        day: day({
          index: 0,
          overnight: { name: 'Lillehammer', lat: 61.1, lng: 10.5, country: 'NO' },
        }),
      },
    ]

    await commitInChunks(db, buildCorridorStopWrites(tripRef, writtenDays))

    const snap = await tripRef.collection('corridorStops').get()
    expect(snap.size).toBe(1)
    const stop = snap.docs[0].data() as CorridorStop
    expect(stop.name).toBe('Lillehammer')
    expect(stop.lat).toBe(61.1)
    expect(stop.lng).toBe(10.5)
    expect(stop.country).toBe('NO')
    expect(stop.status).toBe('committed')
    expect(stop.linkedDayIds).toEqual([dayRef.id])
    expect(stop.why).toBeUndefined()
  })

  it('merges consecutive rest days at the same overnight into one stop', async () => {
    const db = getFirestore()
    const { tripId } = await createTripForUser('uidCorridorMerge')
    const tripRef = db.collection('trips').doc(tripId)

    const overnight = { name: 'Otta', lat: 61.77, lng: 9.54, country: 'NO' }
    const driveDayRef = tripRef.collection('days').doc()
    const restDayRef = tripRef.collection('days').doc()
    const writtenDays: { ref: DocumentReference; day: TripDay }[] = [
      { ref: driveDayRef, day: day({ index: 0, overnight }) },
      { ref: restDayRef, day: day({ index: 1, type: 'rest', overnight }) },
    ]

    await commitInChunks(db, buildCorridorStopWrites(tripRef, writtenDays))

    const snap = await tripRef.collection('corridorStops').get()
    expect(snap.size).toBe(1)
    const stop = snap.docs[0].data() as CorridorStop
    expect(stop.linkedDayIds.sort()).toEqual(
      [driveDayRef.id, restDayRef.id].sort(),
    )
  })

  it('keeps distinct overnight stops as separate corridor entries', async () => {
    const db = getFirestore()
    const { tripId } = await createTripForUser('uidCorridorDistinct')
    const tripRef = db.collection('trips').doc(tripId)

    const osloRef = tripRef.collection('days').doc()
    const ottaRef = tripRef.collection('days').doc()
    const writtenDays: { ref: DocumentReference; day: TripDay }[] = [
      {
        ref: osloRef,
        day: day({
          index: 0,
          overnight: { name: 'Oslo', lat: 59.9, lng: 10.7, country: 'NO' },
        }),
      },
      {
        ref: ottaRef,
        day: day({
          index: 1,
          overnight: { name: 'Otta', lat: 61.77, lng: 9.54, country: 'NO' },
        }),
      },
    ]

    await commitInChunks(db, buildCorridorStopWrites(tripRef, writtenDays))

    const snap = await tripRef.collection('corridorStops').get()
    expect(snap.size).toBe(2)
    const names = snap.docs.map((d) => (d.data() as CorridorStop).name).sort()
    expect(names).toEqual(['Oslo', 'Otta'])
  })

  it('populates why from whichever grouped day carries a highlightReason', async () => {
    const db = getFirestore()
    const { tripId } = await createTripForUser('uidCorridorWhy')
    const tripRef = db.collection('trips').doc(tripId)

    const overnight = { name: 'Otta', lat: 61.77, lng: 9.54, country: 'NO' }
    const day0Ref = tripRef.collection('days').doc()
    const day1Ref = tripRef.collection('days').doc()
    const writtenDays: { ref: DocumentReference; day: TripDay }[] = [
      { ref: day0Ref, day: day({ index: 0, overnight }) },
      {
        ref: day1Ref,
        day: day({
          index: 1,
          type: 'rest',
          overnight,
          highlightReason: 'Gateway to Rondane National Park',
        }),
      },
    ]

    await commitInChunks(db, buildCorridorStopWrites(tripRef, writtenDays))

    const snap = await tripRef.collection('corridorStops').get()
    expect(snap.size).toBe(1)
    const stop = snap.docs[0].data() as CorridorStop
    expect(stop.why).toBe('Gateway to Rondane National Park')
  })

  // Regression: a loop trip revisiting its own starting town (or any
  // hub-and-spoke itinerary returning to a base) previously collapsed two
  // unrelated visits into one corridorStops doc, since grouping keyed
  // purely on lat/lng with no adjacency check.
  it('keeps non-consecutive visits to the same coordinates as separate stops', async () => {
    const db = getFirestore()
    const { tripId } = await createTripForUser('uidCorridorLoop')
    const tripRef = db.collection('trips').doc(tripId)

    const oslo = { name: 'Oslo', lat: 59.9, lng: 10.7, country: 'NO' }
    const otta = { name: 'Otta', lat: 61.77, lng: 9.54, country: 'NO' }
    const outboundRef = tripRef.collection('days').doc()
    const middleRef = tripRef.collection('days').doc()
    const returnRef = tripRef.collection('days').doc()
    const writtenDays: { ref: DocumentReference; day: TripDay }[] = [
      { ref: outboundRef, day: day({ index: 0, overnight: oslo }) },
      { ref: middleRef, day: day({ index: 1, overnight: otta }) },
      { ref: returnRef, day: day({ index: 2, overnight: oslo }) },
    ]

    await commitInChunks(db, buildCorridorStopWrites(tripRef, writtenDays))

    const snap = await tripRef.collection('corridorStops').get()
    const stops = snap.docs.map((d) => d.data() as CorridorStop)
    expect(stops).toHaveLength(3)
    const osloStops = stops.filter((s) => s.name === 'Oslo')
    expect(osloStops).toHaveLength(2)
    expect(osloStops.map((s) => s.linkedDayIds).sort()).toEqual(
      [[outboundRef.id], [returnRef.id]].sort(),
    )
  })
})
