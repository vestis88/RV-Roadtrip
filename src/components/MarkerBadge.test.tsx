import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { MarkerBadge } from './MarkerBadge'
import { PRIORITY_PIN_CLASS } from '../lib/mapIcons'

function classesOf(element: HTMLElement): string {
  return element.firstElementChild?.className ?? ''
}

// Requested 2026-08-17: "Green is must see. Yellow is worth a detour. Red is
// if convenient. Of course update color for the pin if the priority is
// changed."
describe('MarkerBadge — interest level as colour', () => {
  it('paints each level its own colour', () => {
    const { container: mustSee } = render(
      <MarkerBadge icon="💡" priority="must-see" />,
    )
    expect(classesOf(mustSee)).toContain('emerald')

    const { container: detour } = render(
      <MarkerBadge icon="💡" priority="worth-a-detour" />,
    )
    expect(classesOf(detour)).toContain('amber')

    const { container: convenient } = render(
      <MarkerBadge icon="💡" priority="nice-if-convenient" />,
    )
    expect(classesOf(convenient)).toContain('rose')
  })

  // The colour comes straight off the stop, so a level changed on the card
  // repaints the pin on the next snapshot — nothing to keep in sync. This is
  // the render half of that: a different priority, a different pin.
  it('repaints when the level changes', () => {
    const { container, rerender } = render(
      <MarkerBadge icon="💡" priority="nice-if-convenient" />,
    )
    expect(classesOf(container)).toContain('rose')

    rerender(<MarkerBadge icon="💡" priority="must-see" />)
    expect(classesOf(container)).toContain('emerald')
    expect(classesOf(container)).not.toContain('rose')
  })

  // Tapping a pin has to visibly answer the tap, and "this one is in my
  // route" is a decision already made — an interest level is a property of a
  // suggestion still being weighed.
  it('lets tap-to-view and in-my-route still win', () => {
    const { container: tapped } = render(
      <MarkerBadge icon="💡" priority="must-see" highlighted />,
    )
    expect(classesOf(tapped)).toContain('orange')
    expect(classesOf(tapped)).not.toContain('emerald')

    const { container: kept } = render(
      <MarkerBadge icon="💡" priority="must-see" selected />,
    )
    expect(classesOf(kept)).toContain('sky')
    expect(classesOf(kept)).not.toContain('emerald')
  })

  // Restaurants, overnight stops and start/finish markers have no interest
  // level, and giving them a coloured ring would make the colours mean less.
  it('stays neutral where there is no level to show', () => {
    const { container } = render(<MarkerBadge icon="🍴" />)
    expect(classesOf(container)).toContain('border-neutral-300')
  })

  // Tailwind scans source text for class names, so a colour composed at
  // runtime produces classes that exist in no stylesheet.
  it('names every class in full rather than composing one', () => {
    for (const value of Object.values(PRIORITY_PIN_CLASS)) {
      expect(value).not.toContain('${')
      expect(value).toMatch(/^border-[a-z]+-\d+ ring-2 ring-[a-z]+-\d+$/)
    }
  })
})
