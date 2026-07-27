import { useEffect, useRef } from 'react'
import { useMapsLibrary } from '@vis.gl/react-google-maps'
import type { NamedPoint } from '@rv/shared'

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
  const containerRef = useRef<HTMLDivElement>(null)
  const elementRef = useRef<google.maps.places.PlaceAutocompleteElement | null>(
    null,
  )
  const placesLibrary = useMapsLibrary('places')

  // Kept current after every render so the event listeners below (attached
  // once per library/field in the effect further down, not per render)
  // always see the latest value/onChange instead of whatever was in scope
  // when the effect last ran.
  const valueRef = useRef(value)
  const onChangeRef = useRef(onChange)
  useEffect(() => {
    valueRef.current = value
    onChangeRef.current = onChange
  })

  // Push external value changes (e.g. loaded from Firestore) into the
  // widget; the widget itself is the source of truth for in-progress typing.
  useEffect(() => {
    if (elementRef.current) elementRef.current.value = value.name
  }, [value.name])

  useEffect(() => {
    if (!placesLibrary || !containerRef.current) return

    const element = new placesLibrary.PlaceAutocompleteElement({
      placeholder: 'City, country',
    })
    element.value = valueRef.current.name
    element.setAttribute('data-testid', testId)
    containerRef.current.appendChild(element)
    elementRef.current = element

    function handleSelect(event: Event) {
      const place = (
        event as google.maps.places.PlacePredictionSelectEvent
      ).placePrediction.toPlace()
      place
        .fetchFields({
          fields: ['displayName', 'formattedAddress', 'location'],
        })
        .then(() => {
          const location = place.location
          if (!location) return
          const name = place.formattedAddress ?? place.displayName ?? ''
          onChangeRef.current({
            name,
            lat: location.lat(),
            lng: location.lng(),
          })
        })
        .catch((error: unknown) =>
          console.error('Place fetchFields failed', error),
        )
    }

    function handleBlur() {
      const currentValue = element.value
      if (currentValue !== valueRef.current.name) {
        onChangeRef.current({ ...valueRef.current, name: currentValue })
      }
    }

    function handleError(event: Event) {
      console.error('PlaceAutocompleteElement gmp-error', event)
    }

    element.addEventListener('gmp-select', handleSelect)
    element.addEventListener('blur', handleBlur)
    element.addEventListener('gmp-error', handleError)

    return () => {
      element.removeEventListener('gmp-select', handleSelect)
      element.removeEventListener('blur', handleBlur)
      element.removeEventListener('gmp-error', handleError)
      element.remove()
      elementRef.current = null
    }
  }, [placesLibrary, testId])

  return (
    <label className="block">
      <span className="field-label">{label}</span>
      {placesLibrary ? (
        <div
          ref={containerRef}
          className="[&>*]:w-full [&>*]:rounded-lg [&>*]:border [&>*]:border-neutral-300 dark:[&>*]:border-neutral-700"
        />
      ) : (
        // Fallback while the Places library is unavailable/still loading, so
        // the field stays usable for plain manual entry either way.
        <input
          data-testid={testId}
          className="field"
          defaultValue={value.name}
          placeholder="City, country"
          onBlur={(event) => {
            if (event.target.value !== value.name) {
              onChange({ ...value, name: event.target.value })
            }
          }}
        />
      )}
    </label>
  )
}
