import { useEffect, useRef, useState } from 'react'
import type { NamedPoint } from '@rv/shared'
import { loadGoogleMapsPlaces } from '../lib/googleMaps'

interface PlaceAutocompleteInputProps {
  label: string
  value: NamedPoint
  onChange: (point: NamedPoint) => void
  testId: string
}

export function PlaceAutocompleteInput({
  label,
  value,
  onChange,
  testId,
}: PlaceAutocompleteInputProps) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [text, setText] = useState(value.name)
  const [syncedName, setSyncedName] = useState(value.name)

  if (value.name !== syncedName) {
    setSyncedName(value.name)
    setText(value.name)
  }

  useEffect(() => {
    let autocomplete: google.maps.places.Autocomplete | undefined
    let listener: google.maps.MapsEventListener | undefined

    loadGoogleMapsPlaces().then((loaded) => {
      if (!loaded || !inputRef.current) return
      autocomplete = new google.maps.places.Autocomplete(inputRef.current, {
        fields: ['name', 'formatted_address', 'geometry'],
      })
      listener = autocomplete.addListener('place_changed', () => {
        const place = autocomplete?.getPlace()
        const location = place?.geometry?.location
        if (!location) return
        const name = place?.formatted_address ?? place?.name ?? ''
        setText(name)
        onChange({ name, lat: location.lat(), lng: location.lng() })
      })
    })

    return () => {
      listener?.remove()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <label className="block">
      <span className="mb-1 block text-sm font-medium text-neutral-700 dark:text-neutral-300">
        {label}
      </span>
      <input
        ref={inputRef}
        data-testid={testId}
        className="w-full rounded border border-neutral-300 px-3 py-2 dark:border-neutral-700 dark:bg-neutral-800 dark:text-white"
        value={text}
        onChange={(event) => setText(event.target.value)}
        onBlur={() => {
          if (text !== value.name) {
            onChange({ ...value, name: text })
          }
        }}
        placeholder="City, country"
      />
    </label>
  )
}
