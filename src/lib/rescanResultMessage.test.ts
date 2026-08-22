import { describe, expect, it } from 'vitest'
import { describeResult } from './rescanResultMessage'
import { MAX_RESCAN_RADIUS_KM } from './rescanRadius'

/**
 * Reported 2026-08-22 over Plansee: "Found 4 places, but they were outside
 * the 7 km searched around the middle of the map — zoom in on them and scan
 * again." Following that instruction shrinks the circle, so it guarantees
 * the same answer — the exact failure the message was rewritten to fix in
 * the other direction, arriving from the other end of the zoom range.
 */
describe('what to do about finds that fell outside the circle', () => {
  it('says zoom out when the circle came from the viewport', () => {
    const said = describeResult(0, 4, 0, 7, false)
    expect(said).toContain('7 km')
    expect(said).toMatch(/zoom out/)
    expect(said).not.toMatch(/zoom in/)
  })

  // At the cap the circle no longer grows with the view, so zooming out
  // only enlarges the part of the screen that is NOT searched.
  it('still says zoom in once the cap is what set the circle', () => {
    const said = describeResult(0, 2, 0, MAX_RESCAN_RADIUS_KM, true)
    expect(said).toMatch(/zoom in/)
    expect(said).not.toMatch(/zoom out/)
  })

  it('reads correctly for a single find', () => {
    const said = describeResult(0, 1, 0, 25, false)
    expect(said).toContain('Found 1 place,')
    expect(said).toMatch(/zoom out/)
  })

  // Unchanged: a find is a find, whatever the circle was.
  it('leads with the finds when there are any', () => {
    expect(describeResult(3, 4, 0, 7, false)).toBe('Found 3 new stops nearby.')
  })
})
