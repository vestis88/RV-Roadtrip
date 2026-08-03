import { describe, expect, it } from 'vitest'
import * as entryPoints from './index.js'
import { claimAccess } from './claimAccessCallable.js'

/**
 * Every callable except claimAccess must refuse a caller whose token has no
 * `access` claim — a signed-in Google account that is not on the allowlist.
 *
 * Written against the module's real exports rather than a hand-maintained
 * list, because a hand-maintained list is exactly what this is guarding
 * against: the gate is only as good as its least-guarded entry point, and a
 * new callable added six months from now will not remind anybody. It has
 * already earned its keep once — createTripShareLink and revokeTripShareLink
 * were written before the gate existed and shipped without the check.
 *
 * claimAccess is the one deliberate exception: it is what hands the claim
 * out, so requiring the claim would make access unobtainable. Its own tests
 * cover what it demands instead (a verified email on the allowlist).
 */
function isCallable(value: unknown): value is {
  run: (request: unknown) => Promise<unknown>
} {
  return (
    typeof value === 'function' &&
    'run' in value &&
    typeof (value as { run: unknown }).run === 'function' &&
    (value as { __endpoint?: { callableTrigger?: unknown } }).__endpoint
      ?.callableTrigger !== undefined
  )
}

const guarded = Object.entries(entryPoints).filter(
  ([name, value]) => isCallable(value) && value !== claimAccess && name !== 'claimAccess',
)

describe('every callable requires the access claim', () => {
  // A sanity check on the enumeration itself: an empty list would make every
  // assertion below vacuous, and it is silent about it.
  it('found the callables to check', () => {
    expect(guarded.length).toBeGreaterThan(8)
  })

  it.each(guarded.map(([name]) => name))('%s refuses a caller without it', async (name) => {
    const callable = guarded.find(([n]) => n === name)![1] as {
      run: (request: unknown) => Promise<unknown>
    }
    await expect(
      callable.run({
        auth: { uid: 'signed-in-stranger', token: { email: 'stranger@example.com' } },
        // Deliberately valid-looking so the rejection can only come from the
        // access check, not from argument validation happening to run first.
        data: { tripId: 'someTrip', countryCode: 'NO', countryName: 'Norway', sectionIds: ['x'] },
        rawRequest: {},
      }),
    ).rejects.toThrow(/does not have access to this app/)
  })
})
