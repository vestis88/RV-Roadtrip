import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SharedTripView } from '@rv/shared'
import { SHARED_TRIP_POLL_MS } from '../lib/sharedTripView'
import { SharedTripScreen } from './SharedTripScreen'

function viewWithName(name: string): SharedTripView {
  return {
    trip: {
      name,
      startDate: '2026-07-10',
      endDate: '2026-07-12',
      startPoint: { name: 'Oslo', lat: 59.91, lng: 10.75 },
      endPoint: { name: 'Otta', lat: 61.77, lng: 9.54 },
      planStatus: 'ready',
      totalKm: 320,
    },
    days: [
      {
        id: 'day1',
        index: 0,
        date: '2026-07-10',
        type: 'drive',
        summary: 'Easy first day north along the Mjøsa lake.',
        overnight: {
          name: 'Lillehammer Camping',
          lat: 61.11,
          lng: 10.46,
          country: 'NO',
        },
        drive: {
          fromName: 'Oslo',
          toName: 'Lillehammer',
          distanceKm: 180,
          durationMin: 150,
          slot: 'morning',
        },
        activities: [
          {
            id: 'a1',
            name: 'Maihaugen Open-Air Museum',
            blurb: 'A hidden-gem open-air museum.',
            status: 'selected',
            category: 'museum',
          },
        ],
        restaurants: [
          {
            id: 'r1',
            name: 'Bryggerikjelleren',
            blurb: 'Cozy cellar restaurant.',
            status: 'suggested',
            meal: 'dinner',
          },
        ],
      },
    ],
    corridorStops: [
      {
        id: 's1',
        name: 'Lillehammer',
        lat: 61.11,
        lng: 10.46,
        country: 'NO',
        status: 'committed',
      },
    ],
    diary: [
      {
        id: 'l1',
        date: '2026-07-10',
        refType: 'activity',
        placeName: 'Maihaugen Open-Air Museum',
        note: 'Kids loved the Viking exhibit.',
        createdAt: '2026-07-10T18:00:00Z',
      },
    ],
    fetchedAt: '2026-07-10T18:05:00Z',
  }
}

const fetchMock = vi.fn()

function renderAtShareLink() {
  return render(
    <MemoryRouter initialEntries={['/share/token-abc']}>
      <Routes>
        <Route path="/share/:token" element={<SharedTripScreen />} />
      </Routes>
    </MemoryRouter>,
  )
}

function jsonResponse(body: SharedTripView) {
  return { ok: true, status: 200, json: () => Promise.resolve(body) }
}

beforeEach(() => {
  // shouldAdvanceTime keeps Testing Library's own waitFor polling alive while
  // still letting a test jump the 30s poll interval on demand.
  vi.useFakeTimers({ shouldAdvanceTime: true })
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('SharedTripScreen', () => {
  it('renders the plan and the diary for a guest', async () => {
    fetchMock.mockResolvedValue(jsonResponse(viewWithName('Oslo to Rome 2026')))

    renderAtShareLink()

    expect(await screen.findByTestId('shared-trip-name')).toHaveTextContent(
      'Oslo to Rome 2026',
    )
    expect(screen.getByTestId('shared-day-heading')).toHaveTextContent(
      'Day 1 — 2026-07-10',
    )
    expect(
      screen.getByText('Easy first day north along the Mjøsa lake.'),
    ).toBeInTheDocument()
    expect(screen.getByTestId('shared-activities-day1-a1')).toHaveTextContent(
      'Maihaugen Open-Air Museum',
    )
    expect(screen.getByTestId('shared-dinner-day1-r1')).toHaveTextContent(
      'Bryggerikjelleren',
    )
    expect(screen.getByTestId('shared-route-stop')).toHaveTextContent(
      'Lillehammer',
    )
    expect(screen.getByTestId('shared-diary-note')).toHaveTextContent(
      'Kids loved the Viking exhibit.',
    )
  })

  /**
   * The whole promise of the feature: nothing a relative can press writes to
   * someone else's trip, because there is nothing to press at all. Asserted
   * over the rendered DOM rather than by reviewing the JSX, so reusing a
   * component that later grows an edit control fails here.
   */
  it('renders no control that could change anything', async () => {
    fetchMock.mockResolvedValue(jsonResponse(viewWithName('Oslo to Rome 2026')))

    const { container } = renderAtShareLink()
    await screen.findByTestId('shared-trip-name')

    expect(container.querySelectorAll('button')).toHaveLength(0)
    expect(container.querySelectorAll('input, textarea, select')).toHaveLength(0)
    expect(container.querySelectorAll('[role="button"]')).toHaveLength(0)
  })

  it('re-reads the endpoint on a timer so the page keeps itself current', async () => {
    fetchMock.mockResolvedValue(jsonResponse(viewWithName('Original name')))
    renderAtShareLink()
    await screen.findByTestId('shared-trip-name')
    expect(fetchMock).toHaveBeenCalledTimes(1)

    fetchMock.mockResolvedValue(jsonResponse(viewWithName('Renamed en route')))
    await vi.advanceTimersByTimeAsync(SHARED_TRIP_POLL_MS)

    await waitFor(() =>
      expect(screen.getByTestId('shared-trip-name')).toHaveTextContent(
        'Renamed en route',
      ),
    )
  })

  it('explains a revoked or mistyped link instead of showing an empty trip', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 404 })

    renderAtShareLink()

    expect(await screen.findByTestId('shared-trip-missing')).toBeInTheDocument()
  })

  it('keeps the last good view on screen when a poll fails', async () => {
    fetchMock.mockResolvedValue(jsonResponse(viewWithName('Oslo to Rome 2026')))
    renderAtShareLink()
    await screen.findByTestId('shared-trip-name')

    fetchMock.mockRejectedValue(new Error('offline'))
    await vi.advanceTimersByTimeAsync(SHARED_TRIP_POLL_MS)

    expect(screen.getByTestId('shared-trip-name')).toHaveTextContent(
      'Oslo to Rome 2026',
    )
  })
})
