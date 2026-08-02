import { getAuth } from 'firebase-admin/auth'
import { getFirestore } from 'firebase-admin/firestore'
import { initializeApp } from 'firebase-admin/app'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { ALLOWLIST_DOC_PATH } from './accessControl.js'

const PROJECT_ID = 'demo-rv-trip-planner'

beforeAll(() => {
  initializeApp({ projectId: PROJECT_ID })
  getFirestore().settings({ ignoreUndefinedProperties: true })
})

function allowlistRef() {
  return getFirestore().collection(ALLOWLIST_DOC_PATH[0]).doc(ALLOWLIST_DOC_PATH[1])
}

async function setAllowlist(emails: string): Promise<void> {
  await allowlistRef().set({ emails })
}

/**
 * setCustomUserClaims writes to a real user record, so the caller has to
 * exist in the Auth emulator — which it always does in production, since a
 * callable only ever sees a uid that Firebase Auth just minted a token for.
 */
async function createUser(uid: string, customClaims?: object): Promise<void> {
  await getAuth().deleteUser(uid).catch(() => undefined)
  await getAuth().createUser({ uid })
  if (customClaims) await getAuth().setCustomUserClaims(uid, customClaims)
}

async function claimsOf(uid: string): Promise<Record<string, unknown> | undefined> {
  return (await getAuth().getUser(uid)).customClaims
}

/** The token the callable runtime would hand a real Google sign-in. */
function authFor(uid: string, email: string, emailVerified = true) {
  return { uid, token: { email, email_verified: emailVerified } }
}

afterEach(async () => {
  await allowlistRef().delete()
})

describe('claimAccess', () => {
  it('grants the access claim to a verified email on the allowlist', async () => {
    await setAllowlist('hogestam@gmail.com,bim.nejdebring@gmail.com')
    await createUser('uidClaimAllowed')
    const { claimAccess } = await import('./claimAccessCallable.js')

    const result = await claimAccess.run({
      auth: authFor('uidClaimAllowed', 'bim.nejdebring@gmail.com'),
    } as never)

    expect(result).toEqual({ access: true })
    expect((await claimsOf('uidClaimAllowed'))?.access).toBe(true)
  })

  // The allowlist is hand-typed; the token's email comes from Google. Neither
  // side's spacing or casing should decide whether the owner can sign in.
  it('matches across casing and spacing on both sides', async () => {
    await setAllowlist('  HOGESTAM@Gmail.com , , bim.nejdebring@gmail.com ')
    await createUser('uidClaimCasing')
    const { claimAccess } = await import('./claimAccessCallable.js')

    await expect(
      claimAccess.run({
        auth: authFor('uidClaimCasing', ' Hogestam@GMAIL.com '),
      } as never),
    ).resolves.toEqual({ access: true })
    expect((await claimsOf('uidClaimCasing'))?.access).toBe(true)
  })

  // An unverified address is an assertion, not a fact — Firebase will mint a
  // token for an email/password account created with an address the caller
  // does not control, and that must not be enough to impersonate the owner.
  it('rejects an allowlisted email that is not verified', async () => {
    await setAllowlist('hogestam@gmail.com')
    await createUser('uidClaimUnverified')
    const { claimAccess } = await import('./claimAccessCallable.js')

    await expect(
      claimAccess.run({
        auth: authFor('uidClaimUnverified', 'hogestam@gmail.com', false),
      } as never),
    ).rejects.toThrow('does not have access to this app')
    expect(await claimsOf('uidClaimUnverified')).toBeUndefined()
  })

  it('rejects a verified email that is not on the allowlist', async () => {
    await setAllowlist('hogestam@gmail.com')
    await createUser('uidClaimStranger')
    const { claimAccess } = await import('./claimAccessCallable.js')

    await expect(
      claimAccess.run({
        auth: authFor('uidClaimStranger', 'someone.else@gmail.com'),
      } as never),
    ).rejects.toThrow('does not have access to this app')
    expect(await claimsOf('uidClaimStranger')).toBeUndefined()
  })

  it('rejects a token with no email on it at all', async () => {
    await setAllowlist('hogestam@gmail.com')
    await createUser('uidClaimNoEmail')
    const { claimAccess } = await import('./claimAccessCallable.js')

    await expect(
      claimAccess.run({
        auth: { uid: 'uidClaimNoEmail', token: { email_verified: true } },
      } as never),
    ).rejects.toThrow('does not have access to this app')
    expect(await claimsOf('uidClaimNoEmail')).toBeUndefined()
  })

  // The most important test here. If the allowlist document is deleted,
  // renamed, or its field emptied, loadAllowedEmails returns [] — and []
  // must mean "nobody", never "no restriction". Getting this backwards
  // reopens the app to every visitor the moment the config goes missing,
  // silently and with no error anywhere.
  it('refuses everyone when the allowlist document is missing (fails closed)', async () => {
    await allowlistRef().delete()
    await createUser('uidClaimNoAllowlistDoc')
    const { claimAccess } = await import('./claimAccessCallable.js')

    await expect(
      claimAccess.run({
        auth: authFor('uidClaimNoAllowlistDoc', 'hogestam@gmail.com'),
      } as never),
    ).rejects.toThrow('does not have access to this app')
    expect(await claimsOf('uidClaimNoAllowlistDoc')).toBeUndefined()
  })

  it('refuses everyone when the allowlist is present but empty (fails closed)', async () => {
    await setAllowlist('   ,  , ')
    await createUser('uidClaimEmptyAllowlist')
    const { claimAccess } = await import('./claimAccessCallable.js')

    await expect(
      claimAccess.run({
        auth: authFor('uidClaimEmptyAllowlist', 'hogestam@gmail.com'),
      } as never),
    ).rejects.toThrow('does not have access to this app')
    expect(await claimsOf('uidClaimEmptyAllowlist')).toBeUndefined()
  })

  // The email is read from the verified token and nowhere else — a caller
  // who names an allowlisted address in the request payload gets nothing.
  it('ignores an allowlisted email supplied in the request data', async () => {
    await setAllowlist('hogestam@gmail.com')
    await createUser('uidClaimSpoofer')
    const { claimAccess } = await import('./claimAccessCallable.js')

    await expect(
      claimAccess.run({
        data: { email: 'hogestam@gmail.com' },
        auth: authFor('uidClaimSpoofer', 'attacker@gmail.com'),
      } as never),
    ).rejects.toThrow('does not have access to this app')
    expect(await claimsOf('uidClaimSpoofer')).toBeUndefined()
  })

  it('rejects a caller who is not signed in', async () => {
    await setAllowlist('hogestam@gmail.com')
    const { claimAccess } = await import('./claimAccessCallable.js')
    await expect(claimAccess.run({} as never)).rejects.toThrow('Must be signed in')
  })

  it('keeps any custom claims the user already had', async () => {
    await setAllowlist('hogestam@gmail.com')
    await createUser('uidClaimExisting', { role: 'owner' })
    const { claimAccess } = await import('./claimAccessCallable.js')

    await claimAccess.run({
      auth: authFor('uidClaimExisting', 'hogestam@gmail.com'),
    } as never)

    expect(await claimsOf('uidClaimExisting')).toEqual({ role: 'owner', access: true })
  })
})
