import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { ExploreCandidateCard } from './ExploreCandidateCard'
import type { CorridorStopWithId } from '../hooks/useCorridorStops'

const stop = {
  id: 's1',
  name: 'Neuschwanstein Castle',
  lat: 47.5576,
  lng: 10.7498,
  country: 'DE',
  status: 'locked',
  linkedDayIds: [],
  priority: 'must-see',
  rank: 0,
} as unknown as CorridorStopWithId

function renderCard(props: Partial<Parameters<typeof ExploreCandidateCard>[0]>) {
  return render(
    <ExploreCandidateCard
      stop={stop}
      detourKm={null}
      onRoute
      highlighted={false}
      onSelect={() => {}}
      onSetPriority={() => {}}
      onLock={() => {}}
      onUnlock={() => {}}
      onReject={() => {}}
      {...props}
    />,
  )
}

/**
 * Asked 2026-08-24: "How do I add to diary?" — the answer was "We've done
 * this", and the answer was hard to find partly because the button committed
 * silently with no chance to say when.
 *
 * The editable moment was specified in the original request ("defaulting to
 * 'now' but possible to change if we are lazy with marking done"), reached
 * markStopDone as a parameter, and then had no UI. These tests are about that
 * gap: the form exists, it is pre-filled, and what it collects is what gets
 * passed on.
 */
describe('marking a stop done from its card', () => {
  it('asks when before committing anything', () => {
    const onMarkDone = vi.fn()
    renderCard({ onMarkDone })

    fireEvent.click(screen.getByTestId('explore-candidate-mark-done-s1'))
    // Nothing is written by opening the form — the traveler has not
    // confirmed a moment yet.
    expect(onMarkDone).not.toHaveBeenCalled()
    expect(screen.getByTestId('explore-candidate-done-form-s1')).toBeTruthy()
  })

  it('pre-fills the moment with now, in local time', () => {
    renderCard({ onMarkDone: vi.fn() })
    fireEvent.click(screen.getByTestId('explore-candidate-mark-done-s1'))

    const input = screen.getByTestId(
      'explore-candidate-done-when-s1',
    ) as HTMLInputElement
    // Local, not UTC: a value built from toISOString would be off by the
    // traveler's own offset and they would "correct" it in the wrong
    // direction. Compared against locally-derived parts so this holds in
    // every zone the app is used from.
    const now = new Date()
    const pad = (value: number) => String(value).padStart(2, '0')
    expect(input.value.slice(0, 10)).toBe(
      `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`,
    )
    expect(input.value.slice(11, 13)).toBe(pad(now.getHours()))
  })

  it('passes the edited moment and the note through', () => {
    const onMarkDone = vi.fn()
    renderCard({ onMarkDone })
    fireEvent.click(screen.getByTestId('explore-candidate-mark-done-s1'))

    fireEvent.change(screen.getByTestId('explore-candidate-done-when-s1'), {
      target: { value: '2026-08-19T14:45' },
    })
    fireEvent.change(screen.getByTestId('explore-candidate-done-note-s1'), {
      target: { value: '  Queued for an hour.  ' },
    })
    fireEvent.click(screen.getByTestId('explore-candidate-done-save-s1'))

    const [when, note] = onMarkDone.mock.calls[0]
    expect(when.getFullYear()).toBe(2026)
    expect(when.getMonth()).toBe(7)
    expect(when.getDate()).toBe(19)
    expect(when.getHours()).toBe(14)
    expect(note).toBe('Queued for an hour.')
  })

  /**
   * An emptied field parses to Invalid Date, and `.toISOString()` on one
   * throws — which would lose the entry at the point of saving it rather
   * than showing an error.
   */
  it('falls back to now rather than throwing on an emptied date', () => {
    const onMarkDone = vi.fn()
    renderCard({ onMarkDone })
    fireEvent.click(screen.getByTestId('explore-candidate-mark-done-s1'))
    fireEvent.change(screen.getByTestId('explore-candidate-done-when-s1'), {
      target: { value: '' },
    })
    fireEvent.click(screen.getByTestId('explore-candidate-done-save-s1'))

    const [when] = onMarkDone.mock.calls[0]
    expect(Number.isFinite(when.getTime())).toBe(true)
  })

  it('cancels without writing anything', () => {
    const onMarkDone = vi.fn()
    renderCard({ onMarkDone })
    fireEvent.click(screen.getByTestId('explore-candidate-mark-done-s1'))
    fireEvent.click(screen.getByTestId('explore-candidate-done-cancel-s1'))

    expect(onMarkDone).not.toHaveBeenCalled()
    expect(screen.queryByTestId('explore-candidate-done-form-s1')).toBeNull()
  })

  /**
   * Reported 2026-08-24: "Need a way to undo marked done as well!" — Undo
   * had shipped, on this card, and was invisible: the link carried no text
   * colour, so it inherited black onto a dark card (see the color-scheme fix
   * in index.css). Asserted here as a rendered control so it cannot quietly
   * stop being offered.
   */
  it('mutes a done card so it reads as behind you', () => {
    const { container } = renderCard({
      stop: { ...stop, doneAt: '2026-08-19T12:45:00.000Z' },
      onUndoDone: vi.fn(),
    })
    // The board has claimed since 2026-08-23 that a done card "stays in the
    // list, muted", and nothing muted it.
    expect(container.querySelector('.opacity-60')).toBeTruthy()
  })

  it('calls back when Undo is pressed', () => {
    const onUndoDone = vi.fn()
    renderCard({
      stop: { ...stop, doneAt: '2026-08-19T12:45:00.000Z' },
      onUndoDone,
    })
    fireEvent.click(screen.getByTestId('explore-candidate-undo-done-s1'))
    expect(onUndoDone).toHaveBeenCalled()
  })

  /**
   * "It seems I'm not even able to get to the day view without clicking in
   * the day list above the map?" — true until this, and a poor answer when
   * the thing you are looking at is the stop rather than the date.
   */
  it('offers a way into the day only when the stop has one', () => {
    const onOpenDay = vi.fn()
    const { unmount } = renderCard({ onOpenDay })
    fireEvent.click(screen.getByTestId('explore-candidate-open-day-s1'))
    expect(onOpenDay).toHaveBeenCalled()
    unmount()

    renderCard({})
    expect(screen.queryByTestId('explore-candidate-open-day-s1')).toBeNull()
  })

  // The done card offers undo instead, and must not offer the form again.
  it('offers undo rather than the form once it is done', () => {
    renderCard({
      stop: { ...stop, doneAt: '2026-08-19T12:45:00.000Z' },
      onUndoDone: vi.fn(),
    })
    expect(screen.queryByTestId('explore-candidate-mark-done-s1')).toBeNull()
    expect(screen.getByTestId('explore-candidate-undo-done-s1')).toBeTruthy()
  })
})
