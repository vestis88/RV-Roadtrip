import { Link } from 'react-router-dom'
import { useTripContext } from '../context/TripContext'
import { useTripDays } from '../hooks/useTripDays'
// Was a local lookup over the sixteen quick-pick countries alone, so any
// other country the plan actually overnighted in listed as a bare code —
// "LU" under a Luxembourg flag. Now that a trip can prefer any country,
// that gap would have been the first thing a Luxembourg trip saw here.
import { countryName } from '../lib/countries'
import { isoCountryFlag } from '../lib/countryFlag'

export function CountriesScreen() {
  const { tripId } = useTripContext()
  const { days } = useTripDays(tripId)

  const codes = Array.from(
    new Set(days.map((day) => day.overnight.country).filter(Boolean)),
  )

  return (
    <div className="mx-auto max-w-2xl p-4 text-left">
      <h2 className="heading-md mb-4">Countries</h2>
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
                className="card-interactive flex items-center gap-3 p-3 font-medium text-neutral-900 dark:text-white"
              >
                <span className="text-2xl">{isoCountryFlag(code)}</span>
                <span>{countryName(code)}</span>
                <span
                  aria-hidden
                  className="ml-auto text-orange-600 dark:text-orange-400"
                >
                  →
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

export default CountriesScreen
