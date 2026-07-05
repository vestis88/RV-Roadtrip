let loadPromise: Promise<boolean> | null = null

export function loadGoogleMapsPlaces(): Promise<boolean> {
  if (loadPromise) return loadPromise

  const apiKey = import.meta.env.VITE_GOOGLE_MAPS_API_KEY
  if (!apiKey) {
    loadPromise = Promise.resolve(false)
    return loadPromise
  }

  loadPromise = new Promise((resolve) => {
    const script = document.createElement('script')
    script.src = `https://maps.googleapis.com/maps/api/js?key=${apiKey}&libraries=places&loading=async&callback=__rvGoogleMapsLoaded`
    script.async = true
    ;(window as unknown as Record<string, () => void>).__rvGoogleMapsLoaded =
      () => resolve(true)
    script.onerror = () => resolve(false)
    document.head.appendChild(script)
  })

  return loadPromise
}
