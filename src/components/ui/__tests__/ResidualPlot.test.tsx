import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup } from '@testing-library/react'
import { ResidualPlot } from '../ResidualPlot'
import type { BatchResidualRow } from '@/orbit/types'

// =============================================================================
// Canvas 2D context mock (jsdom has no canvas backend)
// =============================================================================

interface CtxMock {
  ctx: CanvasRenderingContext2D
  fillStyles: string[]
  strokeStyles: string[]
  /** moveTo/lineTo calls made while strokeStyle was the edited-marker red. */
  editedStrokeOps: { moveTo: number; lineTo: number }
}

const EDITED_RED = '#ff5555'

function createCtxMock(): CtxMock {
  const fillStyles: string[] = []
  const strokeStyles: string[] = []
  const editedStrokeOps = { moveTo: 0, lineTo: 0 }
  const strokeStyleIsRed = () => strokeStyles[strokeStyles.length - 1] === EDITED_RED
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
    moveTo: vi.fn(() => {
      if (strokeStyleIsRed()) editedStrokeOps.moveTo += 1
    }),
    lineTo: vi.fn(() => {
      if (strokeStyleIsRed()) editedStrokeOps.lineTo += 1
    }),
    arc: vi.fn(),
    fill: vi.fn(),
    stroke: vi.fn(),
    fillText: vi.fn(),
    setLineDash: vi.fn(),
    setTransform: vi.fn(),
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
    editedStrokeOps,
  }
}

function makeRow(overrides?: Partial<BatchResidualRow>): BatchResidualRow {
  return {
    timeJd: 2460310.5,
    obsType: 'range',
    value: [6781.2],
    predicted: [6781.19],
    residual: [0.01],
    sigma: [1e-3],
    normalized: [1],
    edited: false,
    ...overrides,
  }
}

// One row per scalar component: range, range_rate, ra_dec, plus an edited outlier.
const ROWS: BatchResidualRow[] = [
  makeRow(),
  makeRow({
    timeJd: 2460310.51,
    obsType: 'range_rate',
    value: [7.6],
    predicted: [7.6],
    residual: [-0.5e-4],
    sigma: [1e-4],
    normalized: [-0.5],
  }),
  makeRow({
    timeJd: 2460310.52,
    obsType: 'ra_dec',
    value: [1.2, 0.3],
    predicted: [1.2, 0.3],
    residual: [1e-6, -2e-6],
    sigma: [1e-6, 1e-6],
    normalized: [1, -2],
  }),
  makeRow({
    timeJd: 2460310.53,
    obsType: 'range',
    value: [6781.2],
    predicted: [6780.2],
    residual: [1.0],
    sigma: [1e-3],
    normalized: [1000],
    edited: true,
  }),
]

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

describe('ResidualPlot rendering', () => {
  it('renders a canvas with role img and default height', () => {
    const { container } = render(<ResidualPlot rows={ROWS} />)
    const canvas = container.querySelector('canvas')
    expect(canvas).not.toBeNull()
    expect(canvas).toHaveAttribute('role', 'img')
    expect(canvas).toHaveStyle({ height: '140px' })
  })

  it('exposes a data-driven aria-label summary', () => {
    const { getByRole } = render(<ResidualPlot rows={ROWS} />)
    const label = getByRole('img').getAttribute('aria-label') ?? ''
    expect(label).toContain('4 residuals')
    expect(label).toContain('1 edited')
    expect(label).toContain('sigma')
  })

  it('summarizes empty rows without crashing', () => {
    const { getByRole } = render(<ResidualPlot rows={[]} />)
    const label = getByRole('img').getAttribute('aria-label') ?? ''
    expect(label).toContain('no residuals')
  })

  it('honors a custom height prop', () => {
    const { container } = render(<ResidualPlot rows={ROWS} height={200} />)
    expect(container.querySelector('canvas')).toHaveStyle({ height: '200px' })
  })
})

// =============================================================================
// Drawing behavior
// =============================================================================

describe('ResidualPlot drawing', () => {
  it('draws one filled point per active row and none for edited rows', () => {
    render(<ResidualPlot rows={ROWS} />)
    // 4 rows, 1 edited -> 3 circle points.
    expect(mock.ctx.arc).toHaveBeenCalledTimes(3)
    expect(mock.ctx.fill).toHaveBeenCalledTimes(3)
  })

  it('colors points by observation type using Dracula neon values', () => {
    render(<ResidualPlot rows={ROWS} />)
    expect(mock.fillStyles).toContain('#8be9fd') // range -> neon-cyan
    expect(mock.fillStyles).toContain('#bd93f9') // range_rate -> neon-purple
    expect(mock.fillStyles).toContain('#50fa7b') // ra_dec -> neon-green
  })

  it('draws edited rows as red X markers via stroke, not fill', () => {
    render(<ResidualPlot rows={ROWS} />)
    expect(mock.strokeStyles).toContain(EDITED_RED)
    // Each X is two line segments: exactly 2 moveTo + 2 lineTo while the
    // stroke style is the edited-marker red (grid/band/axis strokes differ).
    expect(mock.editedStrokeOps.moveTo).toBe(2)
    expect(mock.editedStrokeOps.lineTo).toBe(2)
    expect(mock.ctx.stroke).toHaveBeenCalled()
    // Only the 3 active rows are filled circles.
    expect(mock.ctx.arc).toHaveBeenCalledTimes(3)
  })

  it('shades the 3-sigma band by default', () => {
    render(<ResidualPlot rows={ROWS} />)
    expect(mock.fillStyles).toContain('rgba(255, 85, 85, 0.08)')
  })

  it('skips the sigma band shading when showSigmaBand is false', () => {
    render(<ResidualPlot rows={ROWS} showSigmaBand={false} />)
    expect(mock.fillStyles).not.toContain('rgba(255, 85, 85, 0.08)')
    // The plot background is still painted.
    expect(mock.fillStyles).toContain('#0d0d12')
  })

  it('draws the plot background even with no rows', () => {
    render(<ResidualPlot rows={[]} />)
    expect(mock.fillStyles).toContain('#0d0d12')
    expect(mock.ctx.arc).not.toHaveBeenCalled()
  })

  it('draws a title when provided', () => {
    render(<ResidualPlot rows={ROWS} title="Batch OD residuals" />)
    const texts = vi.mocked(mock.ctx.fillText).mock.calls.map((c) => c[0])
    expect(texts).toContain('Batch OD residuals')
  })

  it('handles a single-row degenerate time span without crashing', () => {
    render(<ResidualPlot rows={[makeRow()]} />)
    expect(mock.ctx.arc).toHaveBeenCalledTimes(1)
  })
})
