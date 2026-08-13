import { describe, expect, it } from 'vitest'
import {
  STALE_PLAN_LOCK_MS,
  isPlanLockStale,
  planAliveFields,
  planRunEndedFields,
  wasSubmittedBeforeRunEnded,
} from './planLock.js'

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

describe('planRunEndedFields', () => {
  it('stamps an ISO timestamp under the planMeta key the guard reads', () => {
    const fields = planRunEndedFields()
    expect(Object.keys(fields)).toEqual(['planMeta.lastRunEndedAt'])
    expect(Number.isNaN(Date.parse(fields['planMeta.lastRunEndedAt']))).toBe(false)
  })
})

describe('wasSubmittedBeforeRunEnded', () => {
  const runEndedAt = new Date(NOW).toISOString()

  // The whole point of the watermark: the answer does not depend on when the
  // trigger fires. A request written before a run finished is a duplicate
  // however long Eventarc sat on it, so both of these must refuse.
  it('refuses a request written before the run that has since ended', () => {
    expect(wasSubmittedBeforeRunEnded(NOW - 30_000, runEndedAt)).toBe(true)
  })

  it('refuses a request written in the same instant the run ended', () => {
    expect(wasSubmittedBeforeRunEnded(NOW, runEndedAt)).toBe(true)
  })

  // The case the feature exists for: a traveler who can see the finished
  // plan asking for another change.
  it('accepts a request written after the run ended', () => {
    expect(wasSubmittedBeforeRunEnded(NOW + 1, runEndedAt)).toBe(false)
  })

  // A trip that has never had a run — and one whose watermark predates this
  // mechanism or got corrupted — must stay generatable. The status claim is
  // still there to catch a genuinely concurrent request.
  it('accepts anything on a trip with no recorded run', () => {
    expect(wasSubmittedBeforeRunEnded(NOW, undefined)).toBe(false)
  })

  it('accepts rather than wedges the trip on an unparseable watermark', () => {
    expect(wasSubmittedBeforeRunEnded(NOW, 'not-a-date')).toBe(false)
  })
})
