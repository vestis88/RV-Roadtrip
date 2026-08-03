import { readFileSync } from 'node:fs'
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
  type RulesTestEnvironment,
  type TokenOptions,
} from '@firebase/rules-unit-testing'
import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  setDoc,
  updateDoc,
} from 'firebase/firestore'
import { afterAll, beforeAll, beforeEach, describe, it } from 'vitest'

const PROJECT_ID = 'demo-rv-trip-planner-rules'
const TRIP_ID = 'trip1'
const MEMBER_UID = 'memberUid'
const OTHER_MEMBER_UID = 'otherMemberUid'
const STRANGER_UID = 'strangerUid'
const SHARE_TOKEN = 'sT0kEn_sT0kEn_sT0kEn_sT0kEn_sT0kEn_sT0kEn_1'

let testEnv: RulesTestEnvironment

/**
 * Every test below predates the access claim and describes behavior that
 * still has to hold for one of the two trusted accounts — the claim is an
 * additional gate, not a replacement for isMember() — so the default
 * context here carries it. The "no access claim" block at the bottom is
 * what proves the gate itself bites.
 */
function authedDb(uid: string, claims: TokenOptions = { access: true }) {
  return testEnv.authenticatedContext(uid, claims).firestore()
}

async function seedTrip() {
  await testEnv.withSecurityRulesDisabled(async (context) => {
    const db = context.firestore()
    await setDoc(doc(db, 'trips', TRIP_ID), { meta: { name: 'Seed trip' } })
    await setDoc(doc(db, 'trips', TRIP_ID, 'members', MEMBER_UID), {
      joinedAt: '2026-01-01T00:00:00Z',
    })
    await setDoc(doc(db, 'trips', TRIP_ID, 'members', OTHER_MEMBER_UID), {
      joinedAt: '2026-01-01T00:00:00Z',
    })
    await setDoc(doc(db, 'trips', TRIP_ID, 'days', 'day1'), {
      index: 0,
      summary: 'Day one',
    })
    await setDoc(doc(db, 'shareCodes', 'AB12CD'), { tripId: TRIP_ID })
    await setDoc(doc(db, 'shareTokens', SHARE_TOKEN), {
      tripId: TRIP_ID,
      createdAt: '2026-01-01T00:00:00Z',
    })
    await setDoc(doc(db, 'users', MEMBER_UID, 'trips', TRIP_ID), {
      joinedAt: '2026-01-01T00:00:00Z',
    })
  })
}

beforeEach(async () => {
  await testEnv.clearFirestore()
  await seedTrip()
})

beforeAll(async () => {
  testEnv = await initializeTestEnvironment({
    projectId: PROJECT_ID,
    firestore: {
      rules: readFileSync('../firestore.rules', 'utf8'),
      host: '127.0.0.1',
      port: 8080,
    },
  })
})

afterAll(async () => {
  await testEnv.cleanup()
})

describe('trips/{tripId}', () => {
  it('lets a member read the trip', async () => {
    const db = authedDb(MEMBER_UID)
    await assertSucceeds(getDoc(doc(db, 'trips', TRIP_ID)))
  })

  it('lets a member update the trip', async () => {
    const db = authedDb(MEMBER_UID)
    await assertSucceeds(
      updateDoc(doc(db, 'trips', TRIP_ID), { 'meta.name': 'Renamed trip' }),
    )
  })

  it('denies a stranger reading the trip', async () => {
    const db = authedDb(STRANGER_UID)
    await assertFails(getDoc(doc(db, 'trips', TRIP_ID)))
  })

  it('denies a stranger updating the trip', async () => {
    const db = authedDb(STRANGER_UID)
    await assertFails(
      updateDoc(doc(db, 'trips', TRIP_ID), { 'meta.name': 'Hijacked' }),
    )
  })

  it('denies an unauthenticated client reading the trip', async () => {
    const db = testEnv.unauthenticatedContext().firestore()
    await assertFails(getDoc(doc(db, 'trips', TRIP_ID)))
  })

  it('denies direct client creation of a trip (must go through createTrip)', async () => {
    const db = authedDb(STRANGER_UID)
    await assertFails(setDoc(doc(db, 'trips', 'trip2'), { meta: {} }))
  })

  it('denies deleting the trip document', async () => {
    const db = authedDb(MEMBER_UID)
    await assertFails(deleteDoc(doc(db, 'trips', TRIP_ID)))
  })
})

describe('trips/{tripId}/days (and other subcollections)', () => {
  it('lets a member create, read, update, and delete a day doc', async () => {
    const db = authedDb(MEMBER_UID)
    const dayRef = doc(db, 'trips', TRIP_ID, 'days', 'day2')

    await assertSucceeds(setDoc(dayRef, { index: 1, summary: 'Day two' }))
    await assertSucceeds(getDoc(dayRef))
    await assertSucceeds(updateDoc(dayRef, { summary: 'Updated' }))
    await assertSucceeds(deleteDoc(dayRef))
  })

  it('lets any member of the trip write, not just the creator', async () => {
    const db = authedDb(OTHER_MEMBER_UID)
    await assertSucceeds(
      updateDoc(doc(db, 'trips', TRIP_ID, 'days', 'day1'), {
        summary: 'Edited by the other member',
      }),
    )
  })

  it('denies a stranger reading or writing a day doc', async () => {
    const db = authedDb(STRANGER_UID)
    const dayRef = doc(db, 'trips', TRIP_ID, 'days', 'day1')
    await assertFails(getDoc(dayRef))
    await assertFails(updateDoc(dayRef, { summary: 'Hijacked' }))
  })
})

describe('trips/{tripId}/corridorStops', () => {
  it('lets a member create, read, update, and delete a corridor stop', async () => {
    const db = authedDb(MEMBER_UID)
    const stopRef = doc(db, 'trips', TRIP_ID, 'corridorStops', 'stop1')

    await assertSucceeds(
      setDoc(stopRef, {
        name: 'Otta',
        lat: 61.77,
        lng: 9.54,
        country: 'NO',
        status: 'committed',
        linkedDayIds: ['day1'],
      }),
    )
    await assertSucceeds(getDoc(stopRef))
    await assertSucceeds(updateDoc(stopRef, { status: 'locked' }))
    await assertSucceeds(deleteDoc(stopRef))
  })

  it('denies a stranger reading or writing a corridor stop', async () => {
    await testEnv.withSecurityRulesDisabled(async (context) => {
      await setDoc(
        doc(context.firestore(), 'trips', TRIP_ID, 'corridorStops', 'stop1'),
        {
          name: 'Otta',
          lat: 61.77,
          lng: 9.54,
          country: 'NO',
          status: 'committed',
          linkedDayIds: ['day1'],
        },
      )
    })
    const db = authedDb(STRANGER_UID)
    const stopRef = doc(db, 'trips', TRIP_ID, 'corridorStops', 'stop1')
    await assertFails(getDoc(stopRef))
    await assertFails(updateDoc(stopRef, { status: 'locked' }))
  })
})

describe('trips/{tripId}/members', () => {
  it('lets a member read the members list', async () => {
    const db = authedDb(MEMBER_UID)
    await assertSucceeds(getDocs(collection(db, 'trips', TRIP_ID, 'members')))
  })

  it('denies a stranger reading the members list', async () => {
    const db = authedDb(STRANGER_UID)
    await assertFails(getDocs(collection(db, 'trips', TRIP_ID, 'members')))
  })

  it('denies a member adding themselves directly (must go through joinTrip)', async () => {
    const db = authedDb(STRANGER_UID)
    await assertFails(
      setDoc(doc(db, 'trips', TRIP_ID, 'members', STRANGER_UID), {
        joinedAt: '2026-01-01T00:00:00Z',
      }),
    )
  })

  it("denies even an existing member overwriting another member's doc", async () => {
    const db = authedDb(MEMBER_UID)
    await assertFails(
      setDoc(doc(db, 'trips', TRIP_ID, 'members', OTHER_MEMBER_UID), {
        joinedAt: 'tampered',
      }),
    )
  })
})

describe('users/{uid}/trips', () => {
  it('lets a user read their own trip list', async () => {
    const db = authedDb(MEMBER_UID)
    await assertSucceeds(
      getDoc(doc(db, 'users', MEMBER_UID, 'trips', TRIP_ID)),
    )
  })

  it("denies reading another user's trip list", async () => {
    const db = authedDb(STRANGER_UID)
    await assertFails(getDoc(doc(db, 'users', MEMBER_UID, 'trips', TRIP_ID)))
  })

  it('denies writing a reverse-index entry for a trip the caller is not a member of', async () => {
    const db = authedDb(MEMBER_UID)
    await assertFails(
      setDoc(doc(db, 'users', MEMBER_UID, 'trips', 'someOtherTripId'), {
        joinedAt: '2026-01-01T00:00:00Z',
      }),
    )
  })

  it("denies writing into another user's trip list even for a trip the caller belongs to", async () => {
    const db = authedDb(OTHER_MEMBER_UID)
    await assertFails(
      setDoc(doc(db, 'users', MEMBER_UID, 'trips', TRIP_ID), {
        joinedAt: '2026-01-01T00:00:00Z',
      }),
    )
  })

  it('lets a member self-heal a missing reverse-index entry for their own trip (useTripSession.ts backfill)', async () => {
    const db = authedDb(OTHER_MEMBER_UID)
    await assertSucceeds(
      setDoc(doc(db, 'users', OTHER_MEMBER_UID, 'trips', TRIP_ID), {
        joinedAt: '2026-01-01T00:00:00Z',
      }),
    )
  })
})

describe('shareCodes/{code}', () => {
  it('denies any client read (only Cloud Functions resolve codes)', async () => {
    const db = authedDb(MEMBER_UID)
    await assertFails(getDoc(doc(db, 'shareCodes', 'AB12CD')))
  })

  it('denies any client write', async () => {
    const db = authedDb(MEMBER_UID)
    await assertFails(
      setDoc(doc(db, 'shareCodes', 'ZZ99ZZ'), { tripId: TRIP_ID }),
    )
  })
})

// The family view link's only access control is the secrecy of its token
// (viewSharedTrip resolves it through the Admin SDK). A client that could
// read this collection could enumerate every trip's public link; one that
// could write it could aim an existing link at a trip it has no claim on.
describe('shareTokens/{token}', () => {
  it('denies any client read, member or not', async () => {
    const memberDb = testEnv.authenticatedContext(MEMBER_UID).firestore()
    await assertFails(getDoc(doc(memberDb, 'shareTokens', SHARE_TOKEN)))

    const strangerDb = testEnv.authenticatedContext(STRANGER_UID).firestore()
    await assertFails(getDoc(doc(strangerDb, 'shareTokens', SHARE_TOKEN)))

    const anonDb = testEnv.unauthenticatedContext().firestore()
    await assertFails(getDoc(doc(anonDb, 'shareTokens', SHARE_TOKEN)))
  })

  it('denies listing the collection', async () => {
    const memberDb = testEnv.authenticatedContext(MEMBER_UID).firestore()
    await assertFails(getDocs(collection(memberDb, 'shareTokens')))
  })

  it('denies any client write — creating, repointing, or un-revoking a link', async () => {
    const memberDb = testEnv.authenticatedContext(MEMBER_UID).firestore()
    await assertFails(
      setDoc(doc(memberDb, 'shareTokens', 'mintedByAClient'), {
        tripId: TRIP_ID,
        createdAt: '2026-01-01T00:00:00Z',
      }),
    )
    await assertFails(
      updateDoc(doc(memberDb, 'shareTokens', SHARE_TOKEN), {
        tripId: 'someOtherTripId',
      }),
    )
    await assertFails(deleteDoc(doc(memberDb, 'shareTokens', SHARE_TOKEN)))

    const anonDb = testEnv.unauthenticatedContext().firestore()
    await assertFails(
      setDoc(doc(anonDb, 'shareTokens', 'mintedByAStranger'), {
        tripId: TRIP_ID,
        createdAt: '2026-01-01T00:00:00Z',
      }),
    )
  })
})

describe('planRequests/{requestId}', () => {
  it('lets a trip member create a plan request for their own trip', async () => {
    const db = authedDb(MEMBER_UID)
    await assertSucceeds(
      setDoc(doc(db, 'planRequests', 'req1'), {
        tripId: TRIP_ID,
        kind: 'full',
        status: 'pending',
      }),
    )
  })

  it('denies a signed-in stranger creating a plan request for a trip they are not a member of', async () => {
    const db = authedDb(STRANGER_UID)
    await assertFails(
      setDoc(doc(db, 'planRequests', 'req1Stranger'), {
        tripId: TRIP_ID,
        kind: 'full',
        status: 'pending',
      }),
    )
  })

  it('denies an unauthenticated client creating a plan request', async () => {
    const db = testEnv.unauthenticatedContext().firestore()
    await assertFails(
      setDoc(doc(db, 'planRequests', 'req2'), {
        tripId: TRIP_ID,
        kind: 'full',
        status: 'pending',
      }),
    )
  })

  it('denies updating or deleting a plan request', async () => {
    await testEnv.withSecurityRulesDisabled(async (context) => {
      await setDoc(doc(context.firestore(), 'planRequests', 'req3'), {
        tripId: TRIP_ID,
        kind: 'full',
        status: 'pending',
      })
    })
    const db = authedDb(MEMBER_UID)
    await assertFails(
      updateDoc(doc(db, 'planRequests', 'req3'), { status: 'error' }),
    )
    await assertFails(deleteDoc(doc(db, 'planRequests', 'req3')))
  })

  it('lets a trip member read a plan request for their own trip, but not a stranger', async () => {
    await testEnv.withSecurityRulesDisabled(async (context) => {
      await setDoc(doc(context.firestore(), 'planRequests', 'req4'), {
        tripId: TRIP_ID,
        kind: 'full',
        status: 'pending',
      })
    })
    const memberDb = authedDb(MEMBER_UID)
    await assertSucceeds(getDoc(doc(memberDb, 'planRequests', 'req4')))
    const strangerDb = authedDb(STRANGER_UID)
    await assertFails(getDoc(doc(strangerDb, 'planRequests', 'req4')))
  })
})

// Country research lives outside every trip so one lookup serves them all
// (2026-08-02). That makes it the only shared-across-accounts collection in
// this ruleset, so its two halves both matter: anyone with access may read
// it whether or not they belong to the trip it was researched for, and
// nobody may write it — a client write here would let one traveler poison
// what every other traveler reads.
describe('countryGuideSections', () => {
  const SECTION_DOC_ID = 'NO_camping-rules_any_deadbeef'

  it('lets any traveler with access read research, including one with no trip of their own', async () => {
    await testEnv.withSecurityRulesDisabled(async (context) => {
      await setDoc(
        doc(context.firestore(), 'countryGuideSections', SECTION_DOC_ID),
        {
          countryCode: 'NO',
          sectionId: 'camping-rules',
          title: 'Camping rules',
          items: ['Book ahead in July.'],
          sources: [],
          generatedAt: new Date().toISOString(),
        },
      )
    })
    const strangerDb = authedDb(STRANGER_UID)
    await assertSucceeds(
      getDoc(doc(strangerDb, 'countryGuideSections', SECTION_DOC_ID)),
    )
  })

  it('denies every client write, member or not — only the callable researches', async () => {
    const memberDb = authedDb(MEMBER_UID)
    const ref = doc(memberDb, 'countryGuideSections', SECTION_DOC_ID)
    await assertFails(
      setDoc(ref, {
        countryCode: 'NO',
        sectionId: 'camping-rules',
        title: 'Camping rules',
        items: ['Made up.'],
        sources: [],
        generatedAt: new Date().toISOString(),
      }),
    )
    await assertFails(updateDoc(ref, { items: ['Made up.'] }))
    await assertFails(deleteDoc(ref))
  })

  it('denies reads to a signed-out client', async () => {
    const anonDb = testEnv.unauthenticatedContext().firestore()
    await assertFails(
      getDoc(doc(anonDb, 'countryGuideSections', SECTION_DOC_ID)),
    )
  })
})

describe('users/{uid}/preferences', () => {
  it('lets a traveler read and write their own research brief', async () => {
    const db = authedDb(MEMBER_UID)
    const ref = doc(db, 'users', MEMBER_UID, 'preferences', 'countryBrief')
    await assertSucceeds(
      setDoc(ref, {
        sections: [
          {
            id: 'drinking-water',
            title: 'Drinking water',
            brief: 'Where to refill.',
            dependsOnVehicle: false,
          },
        ],
        updatedAt: new Date().toISOString(),
      }),
    )
    await assertSucceeds(getDoc(ref))
  })

  it('denies reading or writing someone else’s brief', async () => {
    const db = authedDb(STRANGER_UID)
    const ref = doc(db, 'users', MEMBER_UID, 'preferences', 'countryBrief')
    await assertFails(getDoc(ref))
    await assertFails(updateDoc(ref, { sections: [] }))
  })
})

// The login gate (2026-08-02). Before it, any visitor to the URL got an
// anonymous account and, from there, a trip of their own and the ability to
// spend the owner's Claude/Places budget. hasAccess() is what makes signing
// in insufficient: the `access` claim is handed out only by the claimAccess
// callable, only to a verified email on config/allowlist.
//
// Every test here uses MEMBER_UID — a genuine member of TRIP_ID — precisely
// so that membership can't be what's failing. The only difference from the
// passing cases above is the missing claim.
describe('access claim (hasAccess)', () => {
  const noClaimDb = () => authedDb(MEMBER_UID, {})

  it('denies a member without the claim reading or updating the trip', async () => {
    const db = noClaimDb()
    await assertFails(getDoc(doc(db, 'trips', TRIP_ID)))
    await assertFails(updateDoc(doc(db, 'trips', TRIP_ID), { 'meta.name': 'Nope' }))
  })

  it('denies a member without the claim reading or writing a day doc', async () => {
    const db = noClaimDb()
    const dayRef = doc(db, 'trips', TRIP_ID, 'days', 'day1')
    await assertFails(getDoc(dayRef))
    await assertFails(updateDoc(dayRef, { summary: 'Nope' }))
  })

  it('denies a member without the claim reading or writing a corridor stop', async () => {
    const db = noClaimDb()
    const stopRef = doc(db, 'trips', TRIP_ID, 'corridorStops', 'stopNoClaim')
    await assertFails(getDoc(stopRef))
    await assertFails(
      setDoc(stopRef, {
        name: 'Otta',
        lat: 61.77,
        lng: 9.54,
        country: 'NO',
        status: 'committed',
        linkedDayIds: ['day1'],
      }),
    )
  })

  // The expensive one: a planRequests doc starts generatePlan's full
  // Claude/Places/Routes pipeline on the owner's bill.
  it('denies a member without the claim creating a plan request', async () => {
    const db = noClaimDb()
    await assertFails(
      setDoc(doc(db, 'planRequests', 'reqNoClaim'), {
        tripId: TRIP_ID,
        kind: 'full',
        status: 'pending',
      }),
    )
  })

  it('denies a member without the claim reading their own trip list or preferences', async () => {
    const db = noClaimDb()
    await assertFails(getDoc(doc(db, 'users', MEMBER_UID, 'trips', TRIP_ID)))
    await assertFails(
      getDoc(doc(db, 'users', MEMBER_UID, 'preferences', 'countryBrief')),
    )
  })

  it('denies a member without the claim reading country research', async () => {
    await testEnv.withSecurityRulesDisabled(async (context) => {
      await setDoc(
        doc(context.firestore(), 'countryGuideSections', 'NO_camping-rules_any_deadbeef'),
        { countryCode: 'NO', sectionId: 'camping-rules', items: [] },
      )
    })
    await assertFails(
      getDoc(
        doc(noClaimDb(), 'countryGuideSections', 'NO_camping-rules_any_deadbeef'),
      ),
    )
  })

  it('denies a claim that is present but not true', async () => {
    const db = authedDb(MEMBER_UID, { access: 'yes' })
    await assertFails(getDoc(doc(db, 'trips', TRIP_ID)))
  })

  it('lets the same member through on every one of those paths once the claim is there', async () => {
    const db = authedDb(MEMBER_UID)
    await assertSucceeds(getDoc(doc(db, 'trips', TRIP_ID)))
    await assertSucceeds(getDoc(doc(db, 'trips', TRIP_ID, 'days', 'day1')))
    await assertSucceeds(
      setDoc(doc(db, 'trips', TRIP_ID, 'corridorStops', 'stopWithClaim'), {
        name: 'Otta',
        lat: 61.77,
        lng: 9.54,
        country: 'NO',
        status: 'committed',
        linkedDayIds: ['day1'],
      }),
    )
    await assertSucceeds(
      setDoc(doc(db, 'planRequests', 'reqWithClaim'), {
        tripId: TRIP_ID,
        kind: 'full',
        status: 'pending',
      }),
    )
    await assertSucceeds(getDoc(doc(db, 'users', MEMBER_UID, 'trips', TRIP_ID)))
  })
})

// The allowlist the claim is granted from. A client that could read it would
// learn the trusted addresses; a client that could write it would add its own
// and then call claimAccess.
describe('config/{document=**}', () => {
  it('denies every client read and write, claim or no claim', async () => {
    await testEnv.withSecurityRulesDisabled(async (context) => {
      await setDoc(doc(context.firestore(), 'config', 'allowlist'), {
        emails: 'owner@example.com',
      })
    })
    const db = authedDb(MEMBER_UID)
    await assertFails(getDoc(doc(db, 'config', 'allowlist')))
    await assertFails(
      setDoc(doc(db, 'config', 'allowlist'), {
        emails: 'owner@example.com,attacker@example.com',
      }),
    )
    await assertFails(deleteDoc(doc(db, 'config', 'allowlist')))
    await assertFails(getDoc(doc(db, 'config', 'anythingElse')))
  })
})
