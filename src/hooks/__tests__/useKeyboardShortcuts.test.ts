import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook } from '@testing-library/react'
import { useKeyboardShortcuts } from '../useKeyboardShortcuts'
import { useMissionStore } from '@/store/useMissionStore'

vi.mock('@/orbit/wasmLoader', () => ({
  sgp4Init: vi.fn(() => 1),
  sgp4Propagate: vi.fn(),
  sgp4GetElements: vi.fn(),
  sgp4Clear: vi.fn(),
  sgp4Destroy: vi.fn(),
}))

beforeEach(() => {
  useMissionStore.setState({
    satellites: [],
    selectedSatelliteId: null,
    isPlaying: false,
    timeSpeed: 1,
  })
})

describe('useKeyboardShortcuts', () => {
  it('Space toggles play/pause', () => {
    renderHook(() => useKeyboardShortcuts())
    expect(useMissionStore.getState().isPlaying).toBe(false)
    window.dispatchEvent(new KeyboardEvent('keydown', { key: ' ' }))
    expect(useMissionStore.getState().isPlaying).toBe(true)
    window.dispatchEvent(new KeyboardEvent('keydown', { key: ' ' }))
    expect(useMissionStore.getState().isPlaying).toBe(false)
  })

  it('+ doubles time speed', () => {
    renderHook(() => useKeyboardShortcuts())
    useMissionStore.getState().setTimeSpeed(1)
    window.dispatchEvent(new KeyboardEvent('keydown', { key: '+' }))
    expect(useMissionStore.getState().timeSpeed).toBe(2)
  })

  it('- halves time speed', () => {
    renderHook(() => useKeyboardShortcuts())
    useMissionStore.getState().setTimeSpeed(4)
    window.dispatchEvent(new KeyboardEvent('keydown', { key: '-' }))
    expect(useMissionStore.getState().timeSpeed).toBe(2)
  })

  it('clamps speed to max 100', () => {
    renderHook(() => useKeyboardShortcuts())
    useMissionStore.getState().setTimeSpeed(64)
    window.dispatchEvent(new KeyboardEvent('keydown', { key: '+' }))
    expect(useMissionStore.getState().timeSpeed).toBe(100)
  })

  it('clamps speed to min 0.1', () => {
    renderHook(() => useKeyboardShortcuts())
    useMissionStore.getState().setTimeSpeed(0.2)
    window.dispatchEvent(new KeyboardEvent('keydown', { key: '-' }))
    expect(useMissionStore.getState().timeSpeed).toBe(0.1)
  })

  it('Delete removes selected satellite', () => {
    useMissionStore.getState().addSatellite({
      name: 'TEST',
      noradId: 1,
      line1: '1 00001U 00000A   24100.50000000  .00000000  00000-0  00000-0 0  0000',
      line2: '2 00001   0.0000   0.0000 0000000   0.0000   0.0000  1.00000000    00',
      category: 'LEO',
      color: '#8be9fd',
      visible: true,
    })
    const id = useMissionStore.getState().satellites[0]!.id
    useMissionStore.getState().selectSatellite(id)
    renderHook(() => useKeyboardShortcuts())
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete' }))
    expect(useMissionStore.getState().satellites).toHaveLength(0)
  })

  it('ignores keydown in INPUT elements', () => {
    renderHook(() => useKeyboardShortcuts())
    useMissionStore.getState().setTimeSpeed(1)
    const input = document.createElement('input')
    document.body.appendChild(input)
    input.focus()
    input.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }))
    expect(useMissionStore.getState().isPlaying).toBe(false)
    document.body.removeChild(input)
  })
})
