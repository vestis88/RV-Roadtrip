import { getFirestore } from 'firebase-admin/firestore'
import { initializeApp } from 'firebase-admin/app'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { ALLOWLIST_DOC_PATH, loadAllowedEmails, requireAccess } from './accessControl.js'

const PROJECT_ID = 'demo-rv-trip-planner'

beforeAll(() => {
  initializeApp({ projectId: PROJECT_ID })
  getFirestore().settings({ ignoreUndefinedProperties: true })
})

function allowlistRef() {
  return getFirestore().collection(ALLOWLIST_DOC_PATH[0]).doc(ALLOWLIST_DOC_PATH[1])
}

async function setAllowlist(emails: unknown): Promise<void> {
  if (emails === undefined) {
    await allowlistRef().delete()
    return
  }
  await allowlistRef().set({ emails })
}

afterEach(async () => {
  await allowlistRef().delete()
})

describe('loadAllowedEmails', () => {
  it('splits the owner-maintained string into trimmed, lowercased addresses', async () => {
    await setAllowlist('hogestam@gmail.com,bim.nejdebring@gmail.com')
    expect(await loadAllowedEmails()).toEqual([
      'hogestam@gmail.com',
      'bim.nejdebring@gmail.com',
    ])
  })

  // The field is hand-typed in the Firebase console, so every one of these
  // is a realistic way for the owner to write the same two addresses.
  it('tolerates spacing, casing and stray commas', async () => {
    await setAllowlist('  Hogestam@Gmail.com ,, BIM.Nejdebring@GMAIL.COM ,  ')
    expect(await loadAllowedEmails()).toEqual([
      'hogestam@gmail.com',
      'bim.nejdebring@gmail.com',
    ])
  })

  it('reads a single address with no comma at all', async () => {
    await setAllowlist('hogestam@gmail.com')
    expect(await loadAllowedEmails()).toEqual(['hogestam@gmail.com'])
  })

  // Fail closed: an empty list matches nobody, which is the safe direction.
  // The dangerous bug would be treating "no allowlist" as "no restriction".
  it('returns an empty list when the document is missing', async () => {
    await setAllowlist(undefined)
    expect(await loadAllowedEmails()).toEqual([])
  })

  it('returns an empty list when the emails field is blank, absent or not a string', async () => {
    await setAllowlist('')
    expect(await loadAllowedEmails()).toEqual([])
    await setAllowlist('   ')
    expect(await loadAllowedEmails()).toEqual([])
    await allowlistRef().set({ somethingElse: 'hogestam@gmail.com' })
    expect(await loadAllowedEmails()).toEqual([])
    await setAllowlist(['hogestam@gmail.com'])
    expect(await loadAllowedEmails()).toEqual([])
  })
})

describe('requireAccess', () => {
  it('passes a token carrying the access claim', () => {
    expect(() =>
      requireAccess({ uid: 'uidAccessOk', token: { access: true } } as never),
    ).not.toThrow()
  })

  it('rejects a signed-in caller whose token has no access claim', () => {
    expect(() =>
      requireAccess({ uid: 'uidAccessNone', token: {} } as never),
    ).toThrow('does not have access to this app')
  })

  it('rejects a caller who is not signed in at all', () => {
    expect(() => requireAccess(undefined)).toThrow('does not have access to this app')
  })

  // Only the literal boolean counts — a truthy string would otherwise let a
  // claim set by hand to something odd through.
  it('rejects a claim that is truthy but not exactly true', () => {
    expect(() =>
      requireAccess({ uid: 'uidAccessOdd', token: { access: 'yes' } } as never),
    ).toThrow('does not have access to this app')
    expect(() =>
      requireAccess({ uid: 'uidAccessOdd', token: { access: 1 } } as never),
    ).toThrow('does not have access to this app')
  })
})
