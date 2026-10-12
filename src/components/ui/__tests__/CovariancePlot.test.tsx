import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup } from '@testing-library/react'
import { CovariancePlot } from '../CovariancePlot'
import type { EkfStepRow } from '@/orbit/types'

// =============================================================================
// Canvas 2D context mock (jsdom has no canvas backend)
// =============================================================================

interface CtxMock {
  ctx: CanvasRenderingContext2D
  fillStyles: string[]
  strokeStyles: string[]
  /** strokeStyle active at each stroke() call (trace polylines). */
  strokeColors: string[]
}

function createCtxMock(): CtxMock {
  const fillStyles: string[] = []
  const strokeStyles: string[] = []
  const strokeColors: string[] = []
  const ctx: Record<string, unknown> = {
    canvas: null,
    globalAlpha: 1,
    lineWidth: 1,
    font: '',
    textAlign: 'start',
    textBaseline: 'alphabetic',
    clearRect: vi.fn(),
    fillRect: vi.fn(),
    strokeRect: vi.fn(),
    beginPath: vi.fn(),
    closePath: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    arc: vi.fn(),
    fill: vi.fn(),
    stroke: vi.fn(() => {
      strokeColors.push(strokeStyles[strokeStyles.length - 1] ?? '')
    }),
    fillText: vi.fn(),
    setLineDash: vi.fn(),
    setTransform: vi.fn(),
    measureText: vi.fn(() => ({ width: 10 })),
  }
  Object.defineProperty(ctx, 'fillStyle', {
    get: () => fillStyles[fillStyles.length - 1],
    set: (v: string) => fillStyles.push(v),
  })
  Object.defineProperty(ctx, 'strokeStyle', {
    get: () => strokeStyles[strokeStyles.length - 1],
    set: (v: string) => strokeStyles.push(v),
  })
  return {
    ctx: ctx as unknown as CanvasRenderingContext2D,
    fillStyles,
    strokeStyles,
    strokeColors,
  }
}

function makeStep(overrides?: Partial<EkfStepRow>): EkfStepRow {
  return {
    timeJd: 2460310.5,
    obsType: 'range',
    state: [6778, 100, 200, 1, 2, 7],
    sigmas: [1.0, 0.5, 0.25, 1e-3, 5e-4, 2.5e-4],
    nis: [1, null],
    innovation: [0, null],
    updatedMask: [true, false],
    maneuverFlag: false,
    ...overrides,
  }
}

const STEPS: EkfStepRow[] = [
  makeStep(),
  makeStep({
    timeJd: 2460310.51,
    sigmas: [0.5, 0.25, 0.125, 5e-4, 2.5e-4, 1.25e-4],
  }),
  makeStep({
    timeJd: 2460310.52,
    sigmas: [0.25, 0.125, 0.0625, 2.5e-4, 1.25e-4, 6.25e-5],
  }),
]

// Dracula neon per component (duplicated from the component contract).
const NEON = {
  x: '#8be9fd',
  y: '#50fa7b',
  z: '#bd93f9',
  vx: '#ffb86c',
  vy: '#ff5555',
  vz: '#f1fa8c',
}

let mock: CtxMock

beforeEach(() => {
  mock = createCtxMock()
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(mock.ctx)
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

// =============================================================================
// Rendering and accessibility
// =============================================================================

describe('CovariancePlot rendering', () => {
  it('renders a canvas with role img and default height', () => {
    const { container } = render(<CovariancePlot steps={STEPS} />)
    const canvas = container.querySelector('canvas')
    expect(canvas).not.toBeNull()
    expect(canvas).toHaveAttribute('role', 'img')
    expect(canvas).toHaveStyle({ height: '180px' })
  })

  it('exposes a data-driven aria-label summary with units', () => {
    const { getByRole } = render(<CovariancePlot steps={STEPS} />)
    const label = getByRole('img').getAttribute('aria-label') ?? ''
    expect(label).toContain('3 steps')
    expect(label).toContain('log scale')
    expect(label).toContain('km')
    expect(label).toContain('km/s')
    expect(label).toContain('position sigmas')
    expect(label).toContain('velocity sigmas')
  })

  it('reports linear scale when logScale is false', () => {
    const { getByRole } = render(<CovariancePlot steps={STEPS} logScale={false} />)
    const label = getByRole('img').getAttribute('aria-label') ?? ''
    expect(label).toContain('linear scale')
  })

  it('summarizes empty steps without crashing', () => {
    const { getByRole } = render(<CovariancePlot steps={[]} />)
    const label = getByRole('img').getAttribute('aria-label') ?? ''
    expect(label).toContain('no covariance history')
  })

  it('honors a custom height prop', () => {
    const { container } = render(<CovariancePlot steps={STEPS} height={240} />)
    expect(container.querySelector('canvas')).toHaveStyle({ height: '240px' })
  })
})

// =============================================================================
// Drawing behavior
// =============================================================================

describe('CovariancePlot drawing', () => {
  it('draws all six component traces in Dracula neon colors', () => {
    render(<CovariancePlot steps={STEPS} />)
    for (const color of Object.values(NEON)) {
      expect(mock.strokeColors).toContain(color)
    }
  })

  it('draws exactly one polyline stroke per component (two per panel)', () => {
    render(<CovariancePlot steps={STEPS} />)
    for (const color of Object.values(NEON)) {
      const strokes = mock.strokeColors.filter((c) => c === color)
      expect(strokes).toHaveLength(1)
    }
  })

  it('draws position and velocity unit tags', () => {
    render(<CovariancePlot steps={STEPS} />)
    const texts = vi.mocked(mock.ctx.fillText).mock.calls.map((c) => c[0])
    expect(texts).toContain('km')
    expect(texts).toContain('km/s')
  })

  it('draws a legend with the six component labels', () => {
    render(<CovariancePlot steps={STEPS} />)
    const texts = vi.mocked(mock.ctx.fillText).mock.calls.map((c) => c[0])
    for (const label of ['x', 'y', 'z', 'vx', 'vy', 'vz']) {
      expect(texts).toContain(label)
    }
  })

  it('draws decade gridline labels on the log axis', () => {
    render(<CovariancePlot steps={STEPS} />)
    const texts = vi.mocked(mock.ctx.fillText).mock.calls.map((c) => c[0])
    expect(texts.some((t) => typeof t === 'string' && /^1e-?\d+$/.test(t))).toBe(true)
  })

  it('draws the plot background and both panel frames even with no steps', () => {
    render(<CovariancePlot steps={[]} />)
    expect(mock.fillStyles).toContain('#0d0d12')
    expect(mock.ctx.strokeRect).toHaveBeenCalledTimes(2)
  })

  it('renders without traces in linear mode without crashing', () => {
    render(<CovariancePlot steps={STEPS} logScale={false} />)
    expect(mock.strokeColors).toContain(NEON.x)
    expect(mock.strokeColors).toContain(NEON.vz)
  })

  it('draws a title when provided', () => {
    render(<CovariancePlot steps={STEPS} title="EKF covariance" />)
    const texts = vi.mocked(mock.ctx.fillText).mock.calls.map((c) => c[0])
    expect(texts).toContain('EKF covariance')
  })

  it('handles a single-step degenerate time span without crashing', () => {
    render(<CovariancePlot steps={[makeStep()]} />)
    expect(mock.strokeColors).toContain(NEON.x)
  })
})
