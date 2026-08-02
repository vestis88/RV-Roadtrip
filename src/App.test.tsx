import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { AccessStatus } from './lib/appAccess'
import App from './App'

const accessStatus = vi.hoisted(() => ({
  current: { state: 'checking', hasAnonymousTrips: false } as AccessStatus,
}))

vi.mock('./lib/appAccess', () => ({
  watchAccess: (onChange: (status: AccessStatus) => void) => {
    onChange(accessStatus.current)
    return () => {}
  },
  attachGoogleAccount: vi.fn(),
  signOutOfApp: vi.fn(),
}))

// Never resolves: the point of these tests is what renders BEFORE a trip
// exists, and the gate is meant to decide that without waiting on one.
vi.mock('./lib/firebase', () => ({
  ensureSignedIn: () => new Promise(() => {}),
  db: {},
  functions: {},
}))

describe('App', () => {
  it('offers sign-in, and nothing else, to a visitor who is not signed in', () => {
    accessStatus.current = { state: 'signed-out', hasAnonymousTrips: false }
    render(<App />)

    expect(screen.getByTestId('access-sign-in')).toBeInTheDocument()
    // The shell is what creates a trip on mount, so a stranger must never
    // reach it — this assertion is the gate's whole purpose.
    expect(screen.queryByTestId('trip-name-input')).not.toBeInTheDocument()
  })

  it('tells a signed-in but unlisted account why it cannot get in', () => {
    accessStatus.current = {
      state: 'denied',
      email: 'stranger@example.com',
      hasAnonymousTrips: false,
    }
    render(<App />)

    expect(screen.getByTestId('access-denied')).toHaveTextContent(
      'stranger@example.com',
    )
    expect(screen.queryByTestId('access-sign-in')).not.toBeInTheDocument()
  })

  it('renders the app itself once access is granted', () => {
    accessStatus.current = {
      state: 'granted',
      email: 'owner@example.com',
      hasAnonymousTrips: false,
    }
    render(<App />)

    expect(screen.queryByTestId('access-gate')).not.toBeInTheDocument()
    expect(
      screen.getByRole('heading', { name: /rv road trip planner/i }),
    ).toBeInTheDocument()
  })
})
