import { useEffect, useRef } from 'react'
import { useMapsLibrary } from '@vis.gl/react-google-maps'
import type { NamedPoint } from '@rv/shared'
import type { GooglePlaceDetails } from '../lib/googlePlaceDetails'

interface PlaceAutocompleteInputProps {
  label: string
  value: NamedPoint
  onChange: (point: NamedPoint) => void
  testId: string
  /**
   * The rest of what Google knows about the place — its photo, its editorial
   * blurb, its rating and its listing link.
   *
   * Opt-in, and requested 2026-08-31 for one caller: *"when adding a stop
   * ourselves through add stop from a google location, add its photo and
   * brief description as well."* A start or end point in Trip setup wants
   * none of it, and the extra fields are billed per lookup, so they are
   * asked for only when somebody is going to use them. Called with null when
   * the field is edited away from a resolved place, so details can never
   * outlive the place they described — the same rule the coordinates follow.
   */
  onDetails?: (details: GooglePlaceDetails | null) => void
}

export function PlaceAutocompleteInput({
  label,
  value,
  onChange,
  testId,
  onDetails,
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
  const onDetailsRef = useRef(onDetails)
  useEffect(() => {
    valueRef.current = value
    onChangeRef.current = onChange
    onDetailsRef.current = onDetails
  })

  // Push external value changes (e.g. loaded from Firestore) into the
  // widget; the widget itself is the source of truth for in-progress typing.
  useEffect(() => {
    if (elementRef.current) elementRef.current.value = value.name
  }, [value.name])

  useEffect(() => {
    if (!placesLibrary || !containerRef.current) return

    // Asked for only when a caller wants them: `photos`, `editorialSummary`,
    // `rating` and `userRatingCount` sit in a dearer Places billing tier
    // than the three fields every caller needs, and Trip setup's start and
    // end points have no use for a photograph.
    const wantsDetails = !!onDetailsRef.current
    const fields = [
      'displayName',
      'formattedAddress',
      'location',
      ...(wantsDetails
        ? ['photos', 'editorialSummary', 'rating', 'userRatingCount', 'googleMapsURI']
        : []),
    ]

    function readDetails(place: google.maps.places.Place): void {
      if (!onDetailsRef.current) return
      // Every field is optional on the way out — a place with no photo and
      // no blurb is the common case, not a failure.
      const photo = place.photos?.[0]
      onDetailsRef.current({
        ...(photo ? { photoUrl: photo.getURI({ maxWidth: 800 }) } : {}),
        ...(place.editorialSummary ? { summary: place.editorialSummary } : {}),
        ...(place.rating != null ? { rating: place.rating } : {}),
        ...(place.userRatingCount != null
          ? { ratingCount: place.userRatingCount }
          : {}),
        ...(place.googleMapsURI ? { googleMapsUrl: place.googleMapsURI } : {}),
      })
    }

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
        .fetchFields({ fields })
        .then(() => {
          const location = place.location
          if (!location) return
          const name = place.formattedAddress ?? place.displayName ?? ''
          onChangeRef.current({
            name,
            lat: location.lat(),
            lng: location.lng(),
          })
          readDetails(place)
        })
        .catch((error: unknown) =>
          console.error('Place fetchFields failed', error),
        )
    }

    /**
     * Typing a name and moving on without picking a suggestion is a normal
     * thing to do, and the name alone still has to be accepted (a blank
     * start/finish point is what blocks generation — see validateRoute.ts).
     * But keeping the PREVIOUS place's coordinates under a new name is
     * worse than having none: the field reads "Bergen" while its lat/lng
     * still point at Oslo, and every consumer downstream — the map pin, the
     * route backbone, the detour estimates, the stop written to Firestore —
     * silently trusts those coordinates. So the typed text is resolved
     * through the same Places lookup a picked suggestion goes through, and
     * only its own coordinates are ever paired with its own name.
     */
    async function resolveTypedName(typed: string): Promise<void> {
      try {
        const { suggestions } =
          await placesLibrary!.AutocompleteSuggestion.fetchAutocompleteSuggestions({
            input: typed,
          })
        const prediction = suggestions[0]?.placePrediction
        if (!prediction) return
        const place = prediction.toPlace()
        await place.fetchFields({ fields })
        const location = place.location
        if (!location) return
        // The traveler may have kept typing while this was in flight —
        // applying a stale resolution would reintroduce the very mismatch
        // this exists to prevent.
        if (element.value !== typed) return
        onChangeRef.current({
          name: place.formattedAddress ?? place.displayName ?? typed,
          lat: location.lat(),
          lng: location.lng(),
        })
        readDetails(place)
      } catch (error) {
        console.error('Could not resolve typed place name', error)
      }
    }

    function handleBlur() {
      const currentValue = element.value
      if (currentValue === valueRef.current.name) return
      // Accept the name immediately so nothing depending on it has to wait
      // on the network, and drop the now-mismatched coordinates rather than
      // letting them outlive the place they described.
      onChangeRef.current({ name: currentValue, lat: 0, lng: 0 })
      // Dropped with the coordinates, and for the same reason: a photograph
      // of the place you just typed over is worse than none.
      onDetailsRef.current?.(null)
      if (currentValue.trim()) void resolveTypedName(currentValue)
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
