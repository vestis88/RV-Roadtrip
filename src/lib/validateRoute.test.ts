import { describe, expect, it } from 'vitest'
import { hasRoute } from './validateRoute'

const BLANK = { name: '', lat: 0, lng: 0 }
const OSLO = { name: 'Oslo, Norway', lat: 59.91, lng: 10.75 }
const BERGEN = { name: 'Bergen, Norway', lat: 60.39, lng: 5.32 }

describe('hasRoute', () => {
  it('is true when both start and end points are named', () => {
    expect(hasRoute({ startPoint: OSLO, endPoint: BERGEN })).toBe(true)
  })

  it('is false when the end point is still blank (new-trip default)', () => {
    expect(hasRoute({ startPoint: OSLO, endPoint: BLANK })).toBe(false)
  })

  it('is false when the start point is still blank', () => {
    expect(hasRoute({ startPoint: BLANK, endPoint: BERGEN })).toBe(false)
  })

  it('is false when both are blank', () => {
    expect(hasRoute({ startPoint: BLANK, endPoint: BLANK })).toBe(false)
  })

  it('is false for a name that is only whitespace', () => {
    expect(hasRoute({ startPoint: { ...OSLO, name: '   ' }, endPoint: BERGEN })).toBe(
      false,
    )
  })
})
