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

  // The Firebase console puts "array" directly beside "string" in its type
  // dropdown, and a list of addresses invites it. This locked the owner out
  // of his own app on the day the gate shipped: the field was written the
  // way the UI suggested, every address in it was right, and the app told
  // him his own account wasn't on the guest list.
  it('reads an array of addresses, which is how the console invites you to write a list', async () => {
    await setAllowlist(['Hogestam@gmail.com', ' bim.nejdebring@gmail.com '])
    expect(await loadAllowedEmails()).toEqual([
      'hogestam@gmail.com',
      'bim.nejdebring@gmail.com',
    ])
  })

  it('reads addresses written one per line, or separated by semicolons', async () => {
    await setAllowlist('hogestam@gmail.com\nbim.nejdebring@gmail.com')
    expect(await loadAllowedEmails()).toEqual([
      'hogestam@gmail.com',
      'bim.nejdebring@gmail.com',
    ])
    await setAllowlist('hogestam@gmail.com; bim.nejdebring@gmail.com')
    expect(await loadAllowedEmails()).toEqual([
      'hogestam@gmail.com',
      'bim.nejdebring@gmail.com',
    ])
  })

  it('returns an empty list when the emails field is blank, absent or an unusable type', async () => {
    await setAllowlist('')
    expect(await loadAllowedEmails()).toEqual([])
    await setAllowlist('   ')
    expect(await loadAllowedEmails()).toEqual([])
    await allowlistRef().set({ somethingElse: 'hogestam@gmail.com' })
    expect(await loadAllowedEmails()).toEqual([])
    // Tolerating arrays does not mean tolerating anything: a number, or an
    // array with no strings in it, still matches nobody.
    await setAllowlist(42)
    expect(await loadAllowedEmails()).toEqual([])
    await setAllowlist([{ email: 'hogestam@gmail.com' }])
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
