import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import App from './App'

vi.mock('./lib/firebase', () => ({
  ensureSignedIn: () => new Promise(() => {}),
}))

describe('App', () => {
  it('renders the app heading', () => {
    render(<App />)
    expect(
      screen.getByRole('heading', { name: /rv road trip planner/i }),
    ).toBeInTheDocument()
  })
})
