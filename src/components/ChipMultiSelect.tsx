import { useState } from 'react'

interface ChipMultiSelectProps {
  label: string
  options: { value: string; label: string }[]
  selected: string[]
  onChange: (selected: string[]) => void
  allowFreeEntry?: boolean
  testIdPrefix: string
}

export function ChipMultiSelect({
  label,
  options,
  selected,
  onChange,
  allowFreeEntry,
  testIdPrefix,
}: ChipMultiSelectProps) {
  const [freeEntry, setFreeEntry] = useState('')

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
