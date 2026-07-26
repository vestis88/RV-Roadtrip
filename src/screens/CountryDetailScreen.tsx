import { useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { httpsCallable } from 'firebase/functions'
import { useTripContext } from '../context/TripContext'
import { useCountryGuide } from '../hooks/useCountryGuide'
import { functions } from '../lib/firebase'
import { EUROPEAN_COUNTRIES } from '../lib/countries'
import { isoCountryFlag } from '../lib/countryFlag'

function countryName(code: string): string {
  return EUROPEAN_COUNTRIES.find((c) => c.code === code)?.name ?? code
}

function Section({
  title,
  testId,
  children,
}: {
  title: string
  testId: string
  children: React.ReactNode
}) {
  return (
    <details
      className="rounded border border-neutral-200 p-3 dark:border-neutral-800"
      data-testid={testId}
    >
      <summary className="cursor-pointer font-medium text-neutral-900 dark:text-white">
        {title}
      </summary>
      <div className="mt-2 text-sm text-neutral-700 dark:text-neutral-300">
        {children}
      </div>
    </details>
  )
}

export function CountryDetailScreen() {
  const { tripId } = useTripContext()
  const { code } = useParams<{ code: string }>()
  const { guide, loading } = useCountryGuide(tripId, code ?? '')
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function refresh() {
    if (!code) return
    setRefreshing(true)
    setError(null)
    try {
      const call = httpsCallable<
        { tripId: string; countryCode: string },
        { countryCode: string }
      >(functions, 'refreshCountryGuide')
      await call({ tripId, countryCode: code })
    } catch (err) {
      console.error('refreshCountryGuide failed', err)
      setError('Could not refresh this guide right now.')
    } finally {
      setRefreshing(false)
    }
  }

  return (
    <div className="mx-auto max-w-2xl p-4 text-left">
      <Link
        to="/countries"
        className="text-sm text-orange-700 underline dark:text-orange-400"
      >
        ← Back to countries
      </Link>

      <div className="mt-4 flex items-center justify-between">
        <h2 className="text-xl font-semibold text-neutral-900 dark:text-white">
          {isoCountryFlag(code ?? '')} {countryName(code ?? '')}
        </h2>
        <button
          type="button"
          data-testid="refresh-country-guide"
          onClick={refresh}
          disabled={refreshing}
          className="rounded border border-neutral-300 px-3 py-1 text-sm text-neutral-900 disabled:opacity-50 dark:border-neutral-700 dark:text-white"
        >
          {refreshing ? 'Refreshing…' : 'Refresh info'}
        </button>
      </div>

      {error && (
        <p
          className="mt-2 text-sm text-red-600 dark:text-red-400"
          data-testid="refresh-error"
        >
          {error}
        </p>
      )}

      {loading ? (
        <p className="mt-4 text-neutral-500 dark:text-neutral-400">
          Loading…
        </p>
      ) : !guide ? (
        <p
          className="mt-4 text-neutral-500 dark:text-neutral-400"
          data-testid="country-guide-empty"
        >
          No guide yet. Tap "Refresh info" to generate one.
        </p>
      ) : (
        <div className="mt-4 space-y-2" data-testid="country-guide">
          <p
            className="text-xs text-neutral-500 dark:text-neutral-400"
            data-testid="country-guide-generated-at"
          >
            Generated {guide.generatedAt}
          </p>

          <Section title="Driving rules" testId="section-driving-rules">
            <ul className="list-disc space-y-1 pl-4">
              {guide.drivingRules.map((rule, i) => (
                <li key={i}>{rule}</li>
              ))}
            </ul>
          </Section>

          <Section title="Camping rules" testId="section-camping-rules">
            <ul className="list-disc space-y-1 pl-4">
              {guide.campingRules.map((rule, i) => (
                <li key={i}>{rule}</li>
              ))}
            </ul>
          </Section>

          <Section
            title="Free camping rules"
            testId="section-free-camping-rules"
          >
            <ul className="list-disc space-y-1 pl-4">
              {guide.freeCampingRules.map((rule, i) => (
                <li key={i}>{rule}</li>
              ))}
            </ul>
          </Section>

          <Section title="Road fees" testId="section-road-fees">
            <p>{guide.roadFees.summary}</p>
            <p className="mt-1">{guide.roadFees.howToPay}</p>
            {guide.roadFees.vignetteUrl && (
              <a
                href={guide.roadFees.vignetteUrl}
                target="_blank"
                rel="noreferrer"
                className="mt-1 inline-block text-orange-700 underline dark:text-orange-400"
              >
                Buy a vignette
              </a>
            )}
          </Section>

          <Section title="Speed limits" testId="section-speed-limits">
            <p>Urban: {guide.speedLimits.urban}</p>
            <p>Rural: {guide.speedLimits.rural}</p>
            <p>Motorway: {guide.speedLimits.motorway}</p>
            {guide.speedLimits.notes && (
              <p className="mt-1">{guide.speedLimits.notes}</p>
            )}
          </Section>

          <Section title="LPG info" testId="section-lpg-info">
            <p>Adapter needed: {guide.lpgInfo.adapterNeeded}</p>
            <p className="mt-1">
              Common brands: {guide.lpgInfo.commonBrands.join(', ')}
            </p>
            <p className="mt-1">{guide.lpgInfo.tips}</p>
          </Section>
        </div>
      )}
    </div>
  )
}

export default CountryDetailScreen
