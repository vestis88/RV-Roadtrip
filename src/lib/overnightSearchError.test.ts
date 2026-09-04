import { describe, expect, it } from 'vitest'
import {
  GENERIC_OVERNIGHT_SEARCH_ERROR,
  describeOvernightSearchError,
} from './overnightSearchError'

describe('describeOvernightSearchError', () => {
  it('prefers what the server said went wrong', () => {
    expect(
      describeOvernightSearchError({
        code: 'functions/internal',
        message: 'Could not look for places to sleep: credit balance is too low',
      }),
    ).toBe('Could not look for places to sleep: credit balance is too low')
  })

  it('says the search is still running when it ran out of time', () => {
    expect(
      describeOvernightSearchError({ code: 'functions/deadline-exceeded' }),
    ).toContain('still running on the server')
  })

  it('falls back when the rejection carries no cause a traveler can read', () => {
    // The bare code repeated back as its own message — what a browser gets
    // from a container that died before it could explain itself.
    expect(
      describeOvernightSearchError({ code: 'functions/internal', message: 'internal' }),
    ).toBe(GENERIC_OVERNIGHT_SEARCH_ERROR)
    expect(describeOvernightSearchError(new TypeError('Failed to fetch'))).toBe(
      GENERIC_OVERNIGHT_SEARCH_ERROR,
    )
  })
})
