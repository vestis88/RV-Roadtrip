import { describe, expect, it } from 'vitest'
import { panTargetFor } from './mapSelection'

const STOP = { lat: 61.5, lng: 8.3 }
const PLACE = { lat: 59.91, lng: 10.75 }

// Reported 2026-08-19: "Clicking a list item does not pan the map to the
// corresponding pin."
describe('panTargetFor', () => {
  it('pans to a stop chosen from the list', () => {
    expect(panTargetFor(STOP, null)).toEqual(STOP)
  })

  it('still pans to a tapped activity when no stop is selected', () => {
    expect(panTargetFor(null, PLACE)).toEqual(PLACE)
  })

  it('stays put when nothing is selected', () => {
    expect(panTargetFor(null, null)).toBeNull()
  })

  // A backstop rather than a design — the screen clears one selection when
  // the other is made, so this should not arise. If it ever does, the thing
  // the traveler just reached for is the corridor stop.
  it('prefers the corridor stop if both are somehow set', () => {
    expect(panTargetFor(STOP, PLACE)).toEqual(STOP)
  })
})
