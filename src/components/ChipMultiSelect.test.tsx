import { useState } from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { ChipMultiSelect } from './ChipMultiSelect'
import {
  countryChipOptions,
  countryLabel,
  searchCountries,
} from '../lib/countries'

/**
 * Wired exactly the way SettingsScreen wires it — same options builder, same
 * search — because the thing worth testing is the whole "type a country that
 * isn't a chip, end up with a selected chip" path, not the component in
 * isolation with a toy vocabulary.
 */
function CountryChips({
  initial = [],
  onChange,
}: {
  initial?: string[]
  onChange?: (selected: string[]) => void
}) {
  const [selected, setSelected] = useState<string[]>(initial)
  return (
    <ChipMultiSelect
      label="Preferred countries"
      testIdPrefix="country"
      options={countryChipOptions(selected)}
      selected={selected}
      onChange={(next) => {
        setSelected(next)
        onChange?.(next)
      }}
      search={{
        label: 'Search for another country to add',
        placeholder: 'Add another country…',
        emptyLabel: 'No country matches that.',
        alreadySelectedLabel: 'Already in your list.',
        find: (query) =>
          searchCountries(query).map((country) => ({
            value: country.code,
            label: countryLabel(country.code),
          })),
      }}
    />
  )
}

const search = () => screen.getByTestId('country-search')

describe('ChipMultiSelect country search', () => {
  it('shows no results until something is typed', () => {
    render(<CountryChips />)
    expect(screen.queryByTestId('country-search-results')).toBeNull()
  })

  // The reported gap: Luxembourg has no chip, so before this there was no
  // way at all to say a trip went there.
  it('adds a country that has no chip, as its two-letter code', () => {
    const onChange = vi.fn()
    render(<CountryChips onChange={onChange} />)

    expect(screen.queryByTestId('country-chip-LU')).toBeNull()

    fireEvent.change(search(), { target: { value: 'luxem' } })
    fireEvent.click(screen.getByTestId('country-search-result-LU'))

    expect(onChange).toHaveBeenCalledWith(['LU'])
  })

  it('renders the added country as a selected chip, named and deselectable like a preset', () => {
    render(<CountryChips />)
    fireEvent.change(search(), { target: { value: 'luxem' } })
    fireEvent.click(screen.getByTestId('country-search-result-LU'))

    const chip = screen.getByTestId('country-chip-LU')
    // Same aria-pressed + label treatment the preset chips get — not a raw
    // "LU", which is what an unrecognised value used to render as.
    expect(chip).toHaveAttribute('aria-pressed', 'true')
    expect(chip).toHaveTextContent('Luxembourg')
    expect(screen.getByTestId('country-chip-NO')).toHaveAttribute(
      'aria-pressed',
      'false',
    )

    fireEvent.click(chip)
    expect(screen.queryByTestId('country-chip-LU')).toBeNull()
  })

  it('clears the query after a pick, so the next country starts from empty', () => {
    render(<CountryChips />)
    fireEvent.change(search(), { target: { value: 'luxem' } })
    fireEvent.click(screen.getByTestId('country-search-result-LU'))

    expect(search()).toHaveValue('')
    expect(screen.queryByTestId('country-search-results')).toBeNull()
  })

  it('takes the top match on Enter, so a typed-out name needs no second tap', () => {
    render(<CountryChips />)
    fireEvent.change(search(), { target: { value: 'iceland' } })
    fireEvent.keyDown(search(), { key: 'Enter' })

    expect(screen.getByTestId('country-chip-IS')).toHaveAttribute(
      'aria-pressed',
      'true',
    )
  })

  it('leaves an already-selected country out of the results and says why', () => {
    render(<CountryChips initial={['LU']} />)
    fireEvent.change(search(), { target: { value: 'luxem' } })

    expect(screen.queryByTestId('country-search-result-LU')).toBeNull()
    // Not "no match" — the traveler can see the chip; telling them it
    // doesn't exist is the confusing answer.
    expect(screen.getByTestId('country-search-empty')).toHaveTextContent(
      'Already in your list.',
    )
  })

  it('says so plainly when nothing matches', () => {
    render(<CountryChips />)
    fireEvent.change(search(), { target: { value: 'zzzzzz' } })
    expect(screen.getByTestId('country-search-empty')).toHaveTextContent(
      'No country matches that.',
    )
  })

  it('keeps the quick-pick chips one tap away while searching', () => {
    render(<CountryChips />)
    fireEvent.change(search(), { target: { value: 'luxem' } })
    fireEvent.click(screen.getByTestId('country-chip-IT'))

    expect(screen.getByTestId('country-chip-IT')).toHaveAttribute(
      'aria-pressed',
      'true',
    )
  })

  it('has no search box at all when the caller does not ask for one', () => {
    render(
      <ChipMultiSelect
        label="Interests"
        testIdPrefix="interest"
        options={[{ value: 'hiking', label: 'hiking' }]}
        selected={[]}
        onChange={() => {}}
        allowFreeEntry
      />,
    )
    expect(screen.queryByTestId('interest-search')).toBeNull()
    expect(screen.getByTestId('interest-free-entry')).toBeInTheDocument()
  })
})
