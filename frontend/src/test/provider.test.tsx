/**
 * Tests for ProviderContext and ProviderPicker component.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, render, screen, act } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import React from 'react'
import { ProviderProvider, useProvider } from '../contexts/ProviderContext'
import { ProviderPicker } from '../components/ProviderPicker'
import type { HealthResponse } from '../types'

// ─── Wrapper ──────────────────────────────────────────────────────────────

const wrapper = ({ children }: { children: React.ReactNode }) => (
  <ProviderProvider>{children}</ProviderProvider>
)

// ─── Test helper: renders ProviderPicker with a way to observe provider state ──
function TestProviderApp(props: { disabled?: boolean; health?: HealthResponse | null }) {
  const { provider } = useProvider()
  return (
    <div>
      <span data-testid="current">{provider}</span>
      <ProviderPicker disabled={props.disabled} health={props.health} />
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════════════════
// ProviderContext
// ═══════════════════════════════════════════════════════════════════════════

describe('ProviderContext', () => {
  beforeEach(() => localStorage.clear())

  it('defaults to "auto"', () => {
    const { result } = renderHook(() => useProvider(), { wrapper })
    expect(result.current.provider).toBe('auto')
  })

  it('restores "local" from localStorage', () => {
    localStorage.setItem('coldbones-provider', 'local')
    const { result } = renderHook(() => useProvider(), { wrapper })
    expect(result.current.provider).toBe('local')
  })

  it('restores "cloud" from localStorage', () => {
    localStorage.setItem('coldbones-provider', 'cloud')
    const { result } = renderHook(() => useProvider(), { wrapper })
    expect(result.current.provider).toBe('cloud')
  })

  it('restores "cloud-cmi" from localStorage', () => {
    localStorage.setItem('coldbones-provider', 'cloud-cmi')
    const { result } = renderHook(() => useProvider(), { wrapper })
    expect(result.current.provider).toBe('cloud-cmi')
  })

  it('falls back to "auto" for invalid localStorage value', () => {
    localStorage.setItem('coldbones-provider', 'invalid')
    const { result } = renderHook(() => useProvider(), { wrapper })
    expect(result.current.provider).toBe('auto')
  })

  it('setProvider updates state and localStorage', () => {
    const { result } = renderHook(() => useProvider(), { wrapper })
    act(() => result.current.setProvider('cloud'))
    expect(result.current.provider).toBe('cloud')
    expect(localStorage.getItem('coldbones-provider')).toBe('cloud')
  })

  it('setProvider roundtrips through all values', () => {
    const { result } = renderHook(() => useProvider(), { wrapper })
    act(() => result.current.setProvider('local'))
    expect(result.current.provider).toBe('local')
    act(() => result.current.setProvider('cloud'))
    expect(result.current.provider).toBe('cloud')
    act(() => result.current.setProvider('auto'))
    expect(result.current.provider).toBe('auto')
  })

  it('throws when used outside ProviderProvider', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(() => renderHook(() => useProvider())).toThrow('useProvider must be used within a ProviderProvider')
    spy.mockRestore()
  })

  it('persists on mount via useEffect', () => {
    const { result } = renderHook(() => useProvider(), { wrapper })
    // The useEffect writes to localStorage on mount
    expect(localStorage.getItem('coldbones-provider')).toBe('auto')
    act(() => result.current.setProvider('local'))
    expect(localStorage.getItem('coldbones-provider')).toBe('local')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// ProviderPicker
// ═══════════════════════════════════════════════════════════════════════════

describe('ProviderPicker', () => {
  beforeEach(() => localStorage.clear())

  it('renders Auto, Local, Cloud buttons', () => {
    render(<TestProviderApp />, { wrapper })
    expect(screen.getByText('Auto')).toBeInTheDocument()
    expect(screen.getByText('Local')).toBeInTheDocument()
    expect(screen.getByText('Cloud')).toBeInTheDocument()
  })

  it('has role=group with aria-label "Inference provider"', () => {
    render(<TestProviderApp />, { wrapper })
    expect(screen.getByRole('group', { name: /inference provider/i })).toBeInTheDocument()
  })

  it('defaults to Auto active (aria-pressed=true)', () => {
    render(<TestProviderApp />, { wrapper })
    const autoBtn = screen.getByRole('button', { name: /auto/i })
    expect(autoBtn).toHaveAttribute('aria-pressed', 'true')
  })

  it('clicking Local changes provider', async () => {
    render(<TestProviderApp />, { wrapper })
    await userEvent.click(screen.getByText('Local'))
    expect(screen.getByTestId('current')).toHaveTextContent('local')
  })

  it('clicking Cloud changes provider', async () => {
    render(<TestProviderApp />, { wrapper })
    await userEvent.click(screen.getByText('Cloud'))
    expect(screen.getByTestId('current')).toHaveTextContent('cloud')
  })

  it('disabled prevents provider change', async () => {
    render(<TestProviderApp disabled />, { wrapper })
    await userEvent.click(screen.getByText('Local'))
    expect(screen.getByTestId('current')).toHaveTextContent('auto')
  })

  it('adds disabled class when disabled prop is true', () => {
    const { container } = render(<TestProviderApp disabled />, { wrapper })
    expect(container.querySelector('.provider-picker.disabled')).toBeTruthy()
  })

  it('buttons are disabled when disabled prop is true', () => {
    render(<TestProviderApp disabled />, { wrapper })
    const buttons = screen.getAllByRole('button')
    buttons.forEach((btn) => expect(btn).toBeDisabled())
  })

  it('shows online status dot for configured provider', () => {
    const health: HealthResponse = {
      status: 'ok',
      model: 'm',
      provider: 'p',
      model_loaded: true,
      providers: {
        local: { name: 'Local', status: 'configured' },
        cloud: { name: 'Cloud', status: 'configured' },
      },
    }
    const { container } = render(<TestProviderApp health={health} />, { wrapper })
    const dots = container.querySelectorAll('.provider-status-dot.online')
    expect(dots.length).toBe(2) // Local + Cloud both online
  })

  it('shows unknown status dot when no health data', () => {
    const { container } = render(<TestProviderApp health={null} />, { wrapper })
    const dots = container.querySelectorAll('.provider-status-dot.unknown')
    expect(dots.length).toBe(2) // Local + Cloud
  })

  it('shows offline status dot for unexpected provider status', () => {
    const health: HealthResponse = {
      status: 'ok',
      model: 'm',
      provider: 'p',
      model_loaded: true,
      providers: {
        local: { name: 'Local', status: 'error' },
        cloud: { name: 'Cloud', status: 'error' },
      },
    }
    const { container } = render(<TestProviderApp health={health} />, { wrapper })
    const dots = container.querySelectorAll('.provider-status-dot.offline')
    expect(dots.length).toBe(2)
  })

  it('shows unknown dot when provider status is "unknown"', () => {
    const health: HealthResponse = {
      status: 'ok',
      model: 'm',
      provider: 'p',
      model_loaded: true,
      providers: {
        local: { name: 'Local', status: 'unknown' },
        cloud: { name: 'Cloud', status: 'unknown' },
      },
    }
    const { container } = render(<TestProviderApp health={health} />, { wrapper })
    const dots = container.querySelectorAll('.provider-status-dot.unknown')
    expect(dots.length).toBe(2)
  })

  it('Auto button has no status dot', () => {
    render(<TestProviderApp />, { wrapper })
    // Auto button should not have a status dot child
    const autoBtn = screen.getByRole('button', { name: /auto/i })
    expect(autoBtn.querySelector('.provider-status-dot')).toBeNull()
  })

  it('buttons have correct title attributes', () => {
    render(<TestProviderApp />, { wrapper })
    expect(screen.getByTitle(/auto: cloud-primary/i)).toBeInTheDocument()
    expect(screen.getByTitle(/local: rtx 5090/i)).toBeInTheDocument()
    expect(screen.getByTitle(/cloud: bedrock/i)).toBeInTheDocument()
  })

  it('status dot has aria-label', () => {
    const health: HealthResponse = {
      status: 'ok',
      model: 'm',
      provider: 'p',
      model_loaded: true,
      providers: {
        local: { name: 'Local', status: 'configured' },
        cloud: { name: 'Cloud', status: 'configured' },
      },
    }
    render(<TestProviderApp health={health} />, { wrapper })
    expect(screen.getByLabelText('Local online')).toBeInTheDocument()
    expect(screen.getByLabelText('Cloud online')).toBeInTheDocument()
  })
})
