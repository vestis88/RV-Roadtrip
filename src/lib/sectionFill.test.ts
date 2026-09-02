import { describe, expect, it } from 'vitest'
import { sectionFill } from './dayDetailAction'
import type { TripDay } from '@rv/shared'

const NOW = Date.parse('2026-09-01T18:00:00.000Z')
const day = (over: Partial<TripDay>): Pick<
  TripDay,
  'sectionStatus' | 'sectionLastError'
> => over as Pick<TripDay, 'sectionStatus' | 'sectionLastError'>

/**
 * Reported 2026-09-01: "Searched for dinner stops inside today. Closed app,
 * expecting results when I came back. Still nothing. No status."
 */
describe('what a section fill is doing, read off the day', () => {
  it('says nothing is happening when nothing is', () => {
    expect(sectionFill(day({}), 'dinner', NOW)).toEqual({ kind: 'idle' })
  })

  // The whole point: a request in flight survives the app being closed.
  it('reports a fill that was started before the app was closed', () => {
    const startedAt = '2026-09-01T17:59:30.000Z'
    expect(
      sectionFill(day({ sectionStatus: { section: 'dinner', startedAt } }), 'dinner', NOW),
    ).toEqual({ kind: 'working', startedAt })
  })

  /**
   * And so does its failure — which is the case that actually happened: the
   * call failed, the message lived in component state, and the app was
   * closed before anyone read it.
   */
  it('reports a failure that outlived the screen that asked', () => {
    expect(
      sectionFill(
        day({
          sectionLastError: {
            section: 'dinner',
            message: 'Your credit balance is too low',
            failedAt: '2026-09-01T17:40:00.000Z',
          },
        }),
        'dinner',
        NOW,
      ),
    ).toEqual({ kind: 'failed', message: 'Your credit balance is too low' })
  })

  // A dinner that failed says nothing about lunch.
  it('keeps one section’s trouble out of another’s', () => {
    const failed = day({
      sectionLastError: {
        section: 'dinner',
        message: 'boom',
        failedAt: '2026-09-01T17:40:00.000Z',
      },
    })
    expect(sectionFill(failed, 'lunch', NOW)).toEqual({ kind: 'idle' })
  })

  // A container killed mid-run leaves sectionStatus behind with nobody to
  // clear it, and a spinner that never stops is its own kind of lie.
  it('gives up on a run that stopped reporting', () => {
    const startedAt = '2026-09-01T17:40:00.000Z'
    expect(
      sectionFill(day({ sectionStatus: { section: 'dinner', startedAt } }), 'dinner', NOW),
    ).toEqual({ kind: 'stalled', startedAt })
  })

  // Being wrong in the impatient direction costs a second paid call.
  it('trusts a run whose timestamp cannot be read', () => {
    expect(
      sectionFill(
        day({ sectionStatus: { section: 'dinner', startedAt: 'not a date' } }),
        'dinner',
        NOW,
      ).kind,
    ).toBe('working')
  })

  // A run in flight outranks an older failure for the same section.
  it('prefers what is happening now to what happened before', () => {
    expect(
      sectionFill(
        day({
          sectionStatus: {
            section: 'dinner',
            startedAt: '2026-09-01T17:59:30.000Z',
          },
          sectionLastError: {
            section: 'dinner',
            message: 'the previous attempt',
            failedAt: '2026-09-01T17:40:00.000Z',
          },
        }),
        'dinner',
        NOW,
      ).kind,
    ).toBe('working')
  })
})
