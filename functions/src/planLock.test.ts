import { describe, expect, it } from 'vitest'
import { STALE_PLAN_LOCK_MS, isPlanLockStale, planAliveFields } from './planLock.js'

const NOW = Date.parse('2026-08-01T12:00:00.000Z')
const ago = (ms: number) => new Date(NOW - ms).toISOString()

describe('isPlanLockStale', () => {
  it('keeps a claim that was just heartbeated', () => {
    expect(isPlanLockStale(ago(1_000), NOW)).toBe(false)
  })

  it('keeps a claim from a slow but still-alive run', () => {
    expect(isPlanLockStale(ago(STALE_PLAN_LOCK_MS - 60_000), NOW)).toBe(false)
  })

  it('reclaims a claim that has gone quiet past the threshold', () => {
    expect(isPlanLockStale(ago(STALE_PLAN_LOCK_MS + 1), NOW)).toBe(true)
  })

  // Trips already wedged before this mechanism existed carry no timestamp;
  // treating that as fresh would leave them permanently ungeneratable.
  it('reclaims a claim with no timestamp at all', () => {
    expect(isPlanLockStale(undefined, NOW)).toBe(true)
  })

  it('reclaims a claim with an unparseable timestamp rather than trusting it', () => {
    expect(isPlanLockStale('not-a-date', NOW)).toBe(true)
  })
})

describe('planAliveFields', () => {
  it('stamps an ISO timestamp under the planMeta key the guard reads', () => {
    const fields = planAliveFields()
    expect(Object.keys(fields)).toEqual(['planMeta.statusUpdatedAt'])
    expect(Number.isNaN(Date.parse(fields['planMeta.statusUpdatedAt']))).toBe(false)
  })
})
