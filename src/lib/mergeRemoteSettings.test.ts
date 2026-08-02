import { describe, expect, it } from 'vitest'
import type { TripSettings } from '@rv/shared'
import { mergeRemoteSettings } from './mergeRemoteSettings'

function settings(overrides: Partial<TripSettings> = {}): TripSettings {
  return {
    startDate: '2026-07-10',
    endDate: '2026-08-02',
    startPoint: { name: 'Oslo, Norway', lat: 59.91, lng: 10.75 },
    endPoint: { name: 'Bergen, Norway', lat: 60.39, lng: 5.32 },
    travelers: [{ name: 'Bim', role: 'adult' }],
    interests: ['hiking'],
    preferredCountries: ['NO'],
    restDayFrequency: 5,
    maxDriveHoursPerDay: 6,
    vehicle: { lengthMeters: 7, heightMeters: 3 },
    ...overrides,
  } as TripSettings
}

const nothingDirty = new Set<keyof TripSettings>()

describe('mergeRemoteSettings', () => {
  it('returns the same object when nothing differs, so setState bails out', () => {
    const local = settings()
    expect(mergeRemoteSettings(local, settings(), nothingDirty)).toBe(local)
  })

  it('adopts a remote change to a field the traveler has not edited', () => {
    const local = settings()
    const remote = settings({ startDate: '2026-07-12' })
    const merged = mergeRemoteSettings(local, remote, nothingDirty)
    expect(merged).not.toBe(local)
    expect(merged.startDate).toBe('2026-07-12')
  })

  // The bug this exists for: the cached copy carries the right *name* but
  // stale (0, 0) coordinates, which hasRoute rejects — so generation was
  // refused on a trip whose stored route was perfectly valid.
  it('adopts coordinates that changed under an unchanged place name', () => {
    const local = settings({
      endPoint: { name: 'Bergen, Norway', lat: 0, lng: 0 },
    })
    const remote = settings()
    const merged = mergeRemoteSettings(local, remote, nothingDirty)
    expect(merged.endPoint).toEqual({
      name: 'Bergen, Norway',
      lat: 60.39,
      lng: 5.32,
    })
  })

  it('never overwrites a field edited in this mount, even when remote differs', () => {
    const local = settings({ startDate: '2026-09-01' })
    const remote = settings({ startDate: '2026-07-10', endDate: '2026-08-09' })
    const merged = mergeRemoteSettings(
      local,
      remote,
      new Set<keyof TripSettings>(['startDate']),
    )
    // The locally-edited field is kept…
    expect(merged.startDate).toBe('2026-09-01')
    // …while everything else still follows the server.
    expect(merged.endDate).toBe('2026-08-09')
  })

  it('compares arrays of objects by value, not identity', () => {
    const local = settings()
    const remote = settings({ travelers: [{ name: 'Bim', role: 'adult' }] })
    expect(mergeRemoteSettings(local, remote, nothingDirty)).toBe(local)

    const changed = settings({
      travelers: [
        { name: 'Bim', role: 'adult' },
        { name: 'Kid', role: 'child', age: 8 },
      ],
    })
    expect(
      mergeRemoteSettings(local, changed, nothingDirty).travelers,
    ).toHaveLength(2)
  })

  it('treats a shorter array as a real change', () => {
    const local = settings({ interests: ['hiking', 'beaches'] })
    const remote = settings({ interests: ['hiking'] })
    expect(mergeRemoteSettings(local, remote, nothingDirty).interests).toEqual([
      'hiking',
    ])
  })
})
