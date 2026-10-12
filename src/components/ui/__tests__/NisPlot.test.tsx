import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup } from '@testing-library/react'
import { NisPlot } from '../NisPlot'
import type { EkfStepRow } from '@/orbit/types'

// =============================================================================
// Canvas 2D context mock (jsdom has no canvas backend)
// =============================================================================

interface CtxMock {
  ctx: CanvasRenderingContext2D
  fillStyles: string[]
  strokeStyles: string[]
  /** fillStyle active at each arc() call (point colors). */
  arcFillStyles: string[]
  /** setLineDash arguments (gate line uses a non-empty dash). */
  dashCalls: number[][]
}

function createCtxMock(): CtxMock {
  const fillStyles: string[] = []
  const strokeStyles: string[] = []
  const arcFillStyles: string[] = []
  const dashCalls: number[][] = []
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
    arc: vi.fn(() => {
      arcFillStyles.push(fillStyles[fillStyles.length - 1] ?? '')
    }),
    fill: vi.fn(),
    stroke: vi.fn(),
    fillText: vi.fn(),
    setLineDash: vi.fn((dash: number[]) => {
      dashCalls.push([...dash])
    }),
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
    arcFillStyles,
    dashCalls,
  }
}

function makeStep(overrides?: Partial<EkfStepRow>): EkfStepRow {
  return {
    timeJd: 2460310.5,
    obsType: 'range',
    state: [6778, 100, 200, 1, 2, 7],
    sigmas: [0.1, 0.1, 0.1, 1e-4, 1e-4, 1e-4],
    nis: [1.5, null],
    innovation: [0.001, null],
    updatedMask: [true, false],
    maneuverFlag: false,
    ...overrides,
  }
}

// Four steps: one updated below gate, one gated outlier (40 > 25), one
// ra_dec maneuver-flagged step whose max component (9) was updated, and
// one more updated step.
const STEPS: EkfStepRow[] = [
  makeStep(),
  makeStep({
    timeJd: 2460310.51,
    nis: [40, null],
    innovation: [0.5, null],
    updatedMask: [false, false],
  }),
  makeStep({
    timeJd: 2460310.52,
    obsType: 'ra_dec',
    nis: [4, 9],
    innovation: [1e-6, -2e-6],
    updatedMask: [true, true],
    maneuverFlag: true,
  }),
  makeStep({ timeJd: 2460310.53, nis: [2, null] }),
]

const NEON_CYAN = '#8be9fd'
const NEON_RED = '#ff5555'
const NEON_ORANGE = '#ffb86c'

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

describe('NisPlot rendering', () => {
  it('renders a canvas with role img and default height', () => {
    const { container } = render(<NisPlot steps={STEPS} />)
    const canvas = container.querySelector('canvas')
    expect(canvas).not.toBeNull()
    expect(canvas).toHaveAttribute('role', 'img')
    expect(canvas).toHaveStyle({ height: '140px' })
  })

  it('exposes a data-driven aria-label summary', () => {
    const { getByRole } = render(<NisPlot steps={STEPS} />)
    const label = getByRole('img').getAttribute('aria-label') ?? ''
    expect(label).toContain('4 steps')
    expect(label).toContain('log scale')
    expect(label).toContain('1 gated')
    expect(label).toContain('25 gate')
    expect(label).toContain('40.00')
  })

  it('reflects a custom gateThreshold in the summary', () => {
    const { getByRole } = render(<NisPlot steps={STEPS} gateThreshold={9} />)
    const label = getByRole('img').getAttribute('aria-label') ?? ''
    expect(label).toContain('9 gate')
  })

  it('summarizes empty steps without crashing', () => {
    const { getByRole } = render(<NisPlot steps={[]} />)
    const label = getByRole('img').getAttribute('aria-label') ?? ''
    expect(label).toContain('no nis data')
  })

  it('honors a custom height prop', () => {
    const { container } = render(<NisPlot steps={STEPS} height={200} />)
    expect(container.querySelector('canvas')).toHaveStyle({ height: '200px' })
  })
})

// =============================================================================
// Drawing behavior
// =============================================================================

describe('NisPlot drawing', () => {
  it('draws one point per step with finite NIS', () => {
    render(<NisPlot steps={STEPS} />)
    expect(mock.ctx.arc).toHaveBeenCalledTimes(4)
    expect(mock.ctx.fill).toHaveBeenCalledTimes(4)
  })

  it('colors updated points cyan and gated points dimmed red', () => {
    render(<NisPlot steps={STEPS} />)
    expect(mock.arcFillStyles).toContain(NEON_CYAN)
    expect(mock.arcFillStyles).toContain(NEON_RED)
    // Three steps have an updated max component, one is fully gated.
    const cyan = mock.arcFillStyles.filter((c) => c === NEON_CYAN).length
    const red = mock.arcFillStyles.filter((c) => c === NEON_RED).length
    expect(cyan).toBe(3)
    expect(red).toBe(1)
  })

  it('draws the dashed gate line in neon-red', () => {
    render(<NisPlot steps={STEPS} />)
    expect(mock.strokeStyles).toContain(NEON_RED)
    // The gate line is the only dashed stroke.
    expect(mock.dashCalls).toContainEqual([5, 3])
  })

  it('draws vertical neon-orange maneuver markers by default', () => {
    render(<NisPlot steps={STEPS} />)
    expect(mock.strokeStyles).toContain(NEON_ORANGE)
  })

  it('skips maneuver markers when showManeuverMarkers is false', () => {
    render(<NisPlot steps={STEPS} showManeuverMarkers={false} />)
    expect(mock.strokeStyles).not.toContain(NEON_ORANGE)
  })

  it('draws the plot background even with no steps', () => {
    render(<NisPlot steps={[]} />)
    expect(mock.fillStyles).toContain('#0d0d12')
    expect(mock.ctx.arc).not.toHaveBeenCalled()
  })

  it('draws a title when provided', () => {
    render(<NisPlot steps={STEPS} title="EKF NIS" />)
    const texts = vi.mocked(mock.ctx.fillText).mock.calls.map((c) => c[0])
    expect(texts).toContain('EKF NIS')
  })

  it('handles a single-step degenerate time span without crashing', () => {
    render(<NisPlot steps={[makeStep()]} />)
    expect(mock.ctx.arc).toHaveBeenCalledTimes(1)
  })

  it('skips steps whose NIS slots are all null', () => {
    render(
      <NisPlot
        steps={[
          makeStep({ nis: [null, null], innovation: [null, null] }),
          makeStep({ timeJd: 2460310.51 }),
        ]}
      />
    )
    expect(mock.ctx.arc).toHaveBeenCalledTimes(1)
  })
})
