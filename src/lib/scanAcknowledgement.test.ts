import { beforeEach, describe, expect, it, vi } from 'vitest'
import { readSeenScan, rememberSeenScan } from './scanAcknowledgement'

/**
 * Reported 2026-08-31: "The information about the 7 added stops still shows
 * up. It should disappear after looking at any of the stops."
 */
describe('remembering a scan result has been read', () => {
  beforeEach(() => localStorage.clear())

  it('knows nothing about a trip nobody has looked at', () => {
    expect(readSeenScan('trip-1')).toBeNull()
  })

  it('remembers which run was read, per trip', () => {
    rememberSeenScan('trip-1', '2026-08-31T20:16:00.000Z')
    expect(readSeenScan('trip-1')).toBe('2026-08-31T20:16:00.000Z')
    // A different trip's scan is a different message.
    expect(readSeenScan('trip-2')).toBeNull()
  })

  /**
   * The next scan is a new message, not the same one again — which is why
   * the run's timestamp is stored rather than a bare "dismissed" flag.
   */
  it('does not silence the scan that comes after it', () => {
    rememberSeenScan('trip-1', '2026-08-31T20:16:00.000Z')
    expect(readSeenScan('trip-1')).not.toBe('2026-08-31T21:40:00.000Z')
  })

  // A traveler in a private window still gets a working board.
  it('survives storage being unavailable', () => {
    const boom = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied')
    })
    const setBoom = vi
      .spyOn(Storage.prototype, 'setItem')
      .mockImplementation(() => {
        throw new Error('denied')
      })
    expect(() => rememberSeenScan('trip-1', 'now')).not.toThrow()
    expect(readSeenScan('trip-1')).toBeNull()
    boom.mockRestore()
    setBoom.mockRestore()
  })
})
