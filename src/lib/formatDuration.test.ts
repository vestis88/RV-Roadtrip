import { describe, expect, it } from 'vitest'
import { formatDriveTime } from './formatDuration'

describe('formatDriveTime', () => {
  it('stays in minutes below an hour', () => {
    expect(formatDriveTime(45)).toBe('45 min')
    expect(formatDriveTime(59.4)).toBe('59 min')
  })

  it('switches to hours and minutes above one', () => {
    expect(formatDriveTime(80)).toBe('1 h 20 min')
    expect(formatDriveTime(380)).toBe('6 h 20 min')
  })

  it('drops the minutes when a duration lands exactly on the hour', () => {
    expect(formatDriveTime(60)).toBe('1 h')
    expect(formatDriveTime(120)).toBe('2 h')
  })

  // 59.6 rounds to 60, which must read as "1 h" and not "60 min" — the
  // branch is chosen on the rounded value, not the raw one.
  it('rounds before choosing the format, not after', () => {
    expect(formatDriveTime(59.6)).toBe('1 h')
  })

  it('degrades to a readable zero rather than NaN', () => {
    expect(formatDriveTime(0)).toBe('0 min')
    expect(formatDriveTime(-3)).toBe('0 min')
    expect(formatDriveTime(NaN)).toBe('0 min')
  })
})
