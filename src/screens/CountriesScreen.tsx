import { Link } from 'react-router-dom'
import { useTripContext } from '../context/TripContext'
import { useTripDays } from '../hooks/useTripDays'
import { EUROPEAN_COUNTRIES } from '../lib/countries'
import { isoCountryFlag } from '../lib/countryFlag'

function countryName(code: string): string {
  return EUROPEAN_COUNTRIES.find((c) => c.code === code)?.name ?? code
}

export function CountriesScreen() {
  const { tripId } = useTripContext()
  const { days } = useTripDays(tripId)

  const codes = Array.from(
    new Set(days.map((day) => day.overnight.country).filter(Boolean)),
  )

  return (
    <div className="mx-auto max-w-2xl p-4 text-left">
      <h2 className="mb-4 text-xl font-semibold text-neutral-900 dark:text-white">
        Countries
      </h2>
      {codes.length === 0 ? (
        <p
          className="text-neutral-500 dark:text-neutral-400"
          data-testid="countries-empty"
        >
          No countries on the route yet — generate a plan first.
        </p>
      ) : (
        <ul className="space-y-2" data-testid="countries-list">
          {codes.map((code) => (
            <li key={code}>
              <Link
                to={`/countries/${code}`}
                data-testid={`country-link-${code}`}
                className="flex items-center gap-2 rounded border border-neutral-200 p-3 underline dark:border-neutral-800"
              >
                <span>{isoCountryFlag(code)}</span>
                <span>{countryName(code)}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

export default CountriesScreen
