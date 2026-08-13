import { useState } from 'react'

interface ChipOption {
  value: string
  label: string
}

/**
 * Adds a value that isn't offered as a chip, from a fixed vocabulary.
 *
 * Distinct from `allowFreeEntry` on purpose: interests can be anything the
 * traveler types, but preferred countries are stored as ISO 3166-1 alpha-2
 * codes that tripSettingsSchema validates, so typed text can never be the
 * value — it can only be a way of *finding* one. `find` therefore returns
 * whole options (value + label) rather than this component matching strings
 * itself, which keeps country-specific ranking, accents and alternate
 * spellings in lib/countries.ts where they can be unit-tested on their own.
 */
interface ChipSearch {
  /** Visually hidden label for the input — the legend alone doesn't say
   * what the box does, and a placeholder isn't a label. */
  label: string
  placeholder: string
  find: (query: string) => ChipOption[]
  /** Shown when a query matches nothing at all, e.g. "No country matches". */
  emptyLabel: string
  /** Shown when everything a query matched is already selected, so the
   * traveler isn't told a country they can plainly see as a chip above
   * doesn't exist. */
  alreadySelectedLabel: string
}

interface ChipMultiSelectProps {
  label: string
  options: ChipOption[]
  selected: string[]
  onChange: (selected: string[]) => void
  allowFreeEntry?: boolean
  search?: ChipSearch
  testIdPrefix: string
}

export function ChipMultiSelect({
  label,
  options,
  selected,
  onChange,
  allowFreeEntry,
  search,
  testIdPrefix,
}: ChipMultiSelectProps) {
  const [freeEntry, setFreeEntry] = useState('')
  const [query, setQuery] = useState('')

  function toggle(value: string) {
    if (selected.includes(value)) {
      onChange(selected.filter((item) => item !== value))
    } else {
      onChange([...selected, value])
    }
  }

  function addFreeEntry() {
    const value = freeEntry.trim().toLowerCase()
    if (value && !selected.includes(value)) {
      onChange([...selected, value])
    }
    setFreeEntry('')
  }

  const extraSelected = selected.filter(
    (value) => !options.some((option) => option.value === value),
  )

  // Matches are computed on every keystroke rather than behind a debounce:
  // it's a filter over a couple hundred in-memory entries, and a picker
  // that lags a thumb typing "lux" feels broken in a way the saved
  // milliseconds don't pay for.
  const matches = search && query.trim() ? search.find(query) : []
  const available = matches.filter((match) => !selected.includes(match.value))

  function pick(value: string) {
    // Never toggles: a result the traveler taps is one they want added, and
    // everything already selected is filtered out of the list above — so
    // there is no path here that silently *removes* a country. Deselecting
    // stays where it's discoverable, on the chip itself.
    if (!selected.includes(value)) onChange([...selected, value])
    setQuery('')
  }

  return (
    <fieldset>
      <legend className="mb-2 text-sm font-medium text-neutral-700 dark:text-neutral-300">
        {label}
      </legend>
      <div className="flex flex-wrap gap-2">
        {[
          ...options,
          ...extraSelected.map((value) => ({ value, label: value })),
        ].map((option) => {
          const isSelected = selected.includes(option.value)
          return (
            <button
              key={option.value}
              type="button"
              data-testid={`${testIdPrefix}-chip-${option.value}`}
              aria-pressed={isSelected}
              onClick={() => toggle(option.value)}
              className={`rounded-full px-3 py-1.5 text-sm font-medium transition ${
                isSelected
                  ? 'bg-neutral-900 text-white shadow-sm dark:bg-white dark:text-neutral-900'
                  : 'border border-neutral-300 text-neutral-700 hover:bg-neutral-100 dark:border-neutral-600 dark:text-neutral-300 dark:hover:bg-neutral-800'
              }`}
            >
              {option.label}
            </button>
          )
        })}
      </div>
      {search && (
        <div className="mt-3">
          <label className="block">
            <span className="sr-only">{search.label}</span>
            <input
              data-testid={`${testIdPrefix}-search`}
              className="field field-sm"
              type="search"
              value={query}
              // A country name is a proper noun the phone keyboard will
              // happily "correct" into something else mid-word, and the
              // matching is accent- and case-insensitive anyway, so none of
              // this helps and all of it gets in the way.
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={false}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key !== 'Enter') return
                // Enter inside a form would submit it; here it takes the
                // top match, so a traveler who typed the full name never
                // has to move their thumb down to the list.
                event.preventDefault()
                if (available[0]) pick(available[0].value)
              }}
              placeholder={search.placeholder}
            />
          </label>
          {query.trim() && (
            <div
              className="mt-1.5"
              data-testid={`${testIdPrefix}-search-results`}
            >
              {available.length > 0 ? (
                <ul className="card divide-y divide-neutral-200 overflow-hidden dark:divide-neutral-800">
                  {available.map((option) => (
                    <li key={option.value}>
                      <button
                        type="button"
                        data-testid={`${testIdPrefix}-search-result-${option.value}`}
                        onClick={() => pick(option.value)}
                        className="flex min-h-11 w-full items-center px-3 text-left text-sm text-neutral-800 transition hover:bg-neutral-100 dark:text-neutral-100 dark:hover:bg-neutral-800"
                      >
                        {option.label}
                      </button>
                    </li>
                  ))}
                </ul>
              ) : (
                <p
                  data-testid={`${testIdPrefix}-search-empty`}
                  className="text-sm text-neutral-500 dark:text-neutral-400"
                >
                  {matches.length > 0
                    ? search.alreadySelectedLabel
                    : search.emptyLabel}
                </p>
              )}
            </div>
          )}
        </div>
      )}
      {allowFreeEntry && (
        <div className="mt-2 flex gap-2">
          <input
            data-testid={`${testIdPrefix}-free-entry`}
            className="field field-sm flex-1"
            value={freeEntry}
            onChange={(event) => setFreeEntry(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                addFreeEntry()
              }
            }}
            placeholder="Add your own…"
          />
          <button
            type="button"
            data-testid={`${testIdPrefix}-free-entry-add`}
            onClick={addFreeEntry}
            className="btn btn-sm btn-secondary"
          >
            Add
          </button>
        </div>
      )}
    </fieldset>
  )
}
