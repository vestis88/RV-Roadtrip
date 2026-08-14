import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { PlaceCard } from './PlaceCard'

/**
 * A traveler was shown "BIG Shopping" — a shopping centre, 3.8 stars, 9,125
 * reviews — for lunch, described as "Charming lakeside café near the
 * castle". The description belonged to a café Places could not find; the
 * mall was the stand-in, and nothing on the card said so. A stand-in now
 * carries a generic blurb AND says which kind of card it is, because the two
 * claims ("this is the place the plan meant" / "the plan's pick wasn't
 * findable, here's the best-rated one nearby") are different promises.
 */
describe('PlaceCard substitute label', () => {
  it('marks a substitute so it cannot be mistaken for a curated pick', () => {
    render(
      <PlaceCard
        testId="lunch-card-0"
        name="Munkebo Køkken"
        category="restaurant"
        rating={4.6}
        ratingCount={320}
        blurb="A well-rated spot for lunch."
        substitute
      />,
    )

    expect(screen.getByTestId('lunch-card-0-substitute')).toBeInTheDocument()
  })

  it('leaves a verified suggestion unlabelled', () => {
    render(
      <PlaceCard
        testId="lunch-card-0"
        name="Café Sletten"
        category="restaurant"
        rating={4.4}
        ratingCount={210}
        blurb="Charming lakeside café near the castle."
      />,
    )

    expect(screen.queryByTestId('lunch-card-0-substitute')).toBeNull()
  })
})
