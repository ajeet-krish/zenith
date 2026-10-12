import { useEffect, useMemo, useRef } from 'react';
import type { EkfStepRow } from '@/orbit/types';

// =============================================================================
// Covariance Plot (Phase 4): Canvas2D formal sigma history chart
// =============================================================================
// Sequential EKF covariance health chart. Six traces (post-update formal
// sigmas sqrt(diag(J P J^T)) per step): position x/y/z on the TOP panel
// [km] and velocity vx/vy/vz on the BOTTOM panel [km/s]. Two stacked
// sub-panels in one canvas keep the mixed units honest (a single log axis
// would invite km vs km/s comparisons). Log10 Y with decade gridlines by
// default; Dracula neon per component. Follows the ResidualPlot.tsx
// canvas pattern.

// Dracula neon per component (matches Tailwind neon-*).
const SIGMA_COLORS = [
  '#8be9fd', // x: neon-cyan
  '#50fa7b', // y: neon-green
  '#bd93f9', // z: neon-purple
  '#ffb86c', // vx: neon-orange
  '#ff5555', // vy: neon-red
  '#f1fa8c', // vz: neon-yellow
];

const POS_LABELS = ['x', 'y', 'z'];
const VEL_LABELS = ['vx', 'vy', 'vz'];

const PLOT_BG = '#0d0d12';
const GRID_COLOR = 'rgba(68, 71, 90, 0.35)'; // dust
const AXIS_COLOR = '#44475a'; // dust
const TEXT_COLOR = '#6272a4'; // comment
const TITLE_COLOR = '#f8f8f2';
const EMPTY_TEXT = 'No covariance history';

const PAD_LEFT = 46;
const PAD_RIGHT = 8;
const PAD_TOP = 16;
const PAD_BOTTOM = 18;
const PANEL_GAP = 14;
const FALLBACK_WIDTH = 300;

/** Smallest plottable sigma; keeps log10 finite for exact zeros. */
const SIGMA_FLOOR = 1e-16;

/** Max decades labeled before gridlines are thinned out. */
const MAX_LABELED_DECADES = 8;

/** Linear-mode tick count when logScale is false. */
const LINEAR_TICKS = 4;

interface CovariancePlotProps {
  /** Per-step EKF history rows (from an EkfTsResult). */
  steps: EkfStepRow[];
  /** Canvas height [px]. */
  height?: number;
  /** Log10 Y axis with decade gridlines (default true; sigmas span decades). */
  logScale?: boolean;
  /** Optional chart title drawn top-left. */
  title?: string;
}

/** One drawn trace: label, Dracula color, and per-step (minutes, sigma) samples. */
interface SigmaTrace {
  label: string;
  color: string;
  samples: Array<{ xMinutes: number; sigma: number }>;
}

/** Y-axis mapping for one sub-panel. */
interface PanelScale {
  toY: (sigma: number) => number;
  logScale: boolean;
  lo: number;
  hi: number;
}

/** Accessible one-line summary of the sigma history. */
function buildSummary(steps: EkfStepRow[], logScale: boolean): string {
  if (steps.length === 0) return `Covariance plot: ${EMPTY_TEXT.toLowerCase()}`;
  let posMin = Infinity;
  let posMax = 0;
  let velMin = Infinity;
  let velMax = 0;
  for (const step of steps) {
    for (let i = 0; i < 6; ++i) {
      const v = step.sigmas[i];
      if (v == null || !Number.isFinite(v) || v < 0) continue;
      if (i < 3) {
        if (v < posMin) posMin = v;
        if (v > posMax) posMax = v;
      } else {
        if (v < velMin) velMin = v;
        if (v > velMax) velMax = v;
      }
    }
  }
  const scale = logScale ? 'log scale' : 'linear scale';
  const pos =
    posMax > 0
      ? `position sigmas ${posMin.toExponential(1)} to ${posMax.toExponential(1)} km`
      : 'no position sigmas';
  const vel =
    velMax > 0
      ? `velocity sigmas ${velMin.toExponential(1)} to ${velMax.toExponential(1)} km/s`
      : 'no velocity sigmas';
  return `Covariance plot: ${steps.length} steps, ${scale}, ${pos}, ${vel}`;
}

/** Build the six per-component traces from the step rows. */
function buildTraces(steps: EkfStepRow[]): SigmaTrace[] {
  let t0 = steps.length > 0 ? steps[0]!.timeJd : 0;
  for (const step of steps) {
    if (step.timeJd < t0) t0 = step.timeJd;
  }
  const traces: SigmaTrace[] = [];
  for (let i = 0; i < 6; ++i) {
    const samples: Array<{ xMinutes: number; sigma: number }> = [];
    for (const step of steps) {
      const v = step.sigmas[i];
      if (v == null || !Number.isFinite(v) || v < 0) continue;
      samples.push({
        xMinutes: (step.timeJd - t0) * 1440,
        sigma: Math.max(v, SIGMA_FLOOR),
      });
    }
    traces.push({
      label: i < 3 ? POS_LABELS[i]! : VEL_LABELS[i - 3]!,
      color: SIGMA_COLORS[i]!,
      samples,
    });
  }
  return traces;
}

/** Guard degenerate spans so the autoscale never divides by zero. */
function paddedDomain(min: number, max: number, minSpan: number): [number, number] {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [0, 1];
  if (max - min < minSpan) {
    const center = (min + max) / 2;
    return [center - minSpan / 2, center + minSpan / 2];
  }
  const pad = (max - min) * 0.05;
  return [min - pad, max + pad];
}

/**
 * Compute one sub-panel's Y scale from its own traces (honest about units:
 * each panel autoscales independently). Log decades or a padded linear
 * domain, mapped onto [y0, y1].
 */
function makePanelScale(
  traces: SigmaTrace[],
  y0: number,
  y1: number,
  logScale: boolean
): PanelScale {
  let minData = Infinity;
  let maxData = 0;
  for (const trace of traces) {
    for (const s of trace.samples) {
      if (s.sigma < minData) minData = s.sigma;
      if (s.sigma > maxData) maxData = s.sigma;
    }
  }
  const panelH = Math.max(1, y1 - y0);
  if (logScale) {
    if (!Number.isFinite(minData)) {
      minData = SIGMA_FLOOR;
      maxData = 1;
    }
    let logMin = Math.floor(Math.log10(Math.max(minData, SIGMA_FLOOR)));
    let logMax = Math.ceil(Math.log10(Math.max(maxData, SIGMA_FLOOR)));
    if (logMax <= logMin) logMax = logMin + 1;
    return {
      logScale: true,
      lo: logMin,
      hi: logMax,
      toY: (v) =>
        y1 -
        ((Math.log10(Math.max(v, SIGMA_FLOOR)) - logMin) / (logMax - logMin)) *
          panelH,
    };
  }
  if (!Number.isFinite(minData)) {
    minData = 0;
    maxData = 1;
  }
  const [lo, hi] = paddedDomain(0, maxData, 1e-9);
  const span = hi > lo ? hi - lo : 1e-9;
  return {
    logScale: false,
    lo,
    hi,
    toY: (v) => y1 - ((v - lo) / span) * panelH,
  };
}

/** Format a Y tick label: decade exponents in log mode, sig figs in linear. */
function formatTick(v: number, logScale: boolean): string {
  if (logScale) return `1e${Math.round(Math.log10(v))}`;
  if (v === 0) return '0';
  return v.toPrecision(2);
}

/** Draw one sub-panel's chrome: gridlines, frame, unit tag, and legend. */
function drawPanelChrome(
  ctx: CanvasRenderingContext2D,
  traces: SigmaTrace[],
  x0: number,
  x1: number,
  y0: number,
  y1: number,
  scale: PanelScale,
  unitLabel: string
): void {
  const panelW = x1 - x0;
  const panelH = y1 - y0;

  // Gridlines + Y tick labels.
  ctx.strokeStyle = GRID_COLOR;
  ctx.fillStyle = TEXT_COLOR;
  ctx.font = '10px monospace';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  ctx.lineWidth = 1;
  ctx.beginPath();
  if (scale.logScale) {
    const decades = scale.hi - scale.lo;
    const labelStep =
      decades > MAX_LABELED_DECADES ? Math.ceil(decades / MAX_LABELED_DECADES) : 1;
    for (let k = scale.lo; k <= scale.hi; ++k) {
      const y = scale.toY(Math.pow(10, k));
      ctx.moveTo(x0, y);
      ctx.lineTo(x1, y);
      if ((k - scale.lo) % labelStep === 0) {
        ctx.fillText(`1e${k}`, x0 - 4, y);
      }
    }
  } else {
    for (let t = 0; t <= LINEAR_TICKS; ++t) {
      const v = scale.lo + ((scale.hi - scale.lo) * t) / LINEAR_TICKS;
      const y = scale.toY(v);
      ctx.moveTo(x0, y);
      ctx.lineTo(x1, y);
      ctx.fillText(formatTick(v, scale.logScale), x0 - 4, y);
    }
  }
  ctx.stroke();

  // Frame.
  ctx.strokeStyle = AXIS_COLOR;
  ctx.strokeRect(x0, y0, panelW, panelH);

  // Unit tag, top-left inside the panel.
  ctx.fillStyle = TEXT_COLOR;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.fillText(unitLabel, x0 + 4, y0 + 3);

  // Legend, top-right inside the panel: colored component labels.
  ctx.textAlign = 'right';
  let legendX = x1 - 6;
  for (let i = traces.length - 1; i >= 0; --i) {
    const trace = traces[i]!;
    ctx.fillStyle = trace.color;
    ctx.fillText(trace.label, legendX, y0 + 3);
    legendX -= ctx.measureText(trace.label).width + 8;
  }
}

/** Draw the trace polylines for one sub-panel using its scale. */
function drawTraces(
  ctx: CanvasRenderingContext2D,
  traces: SigmaTrace[],
  toX: (minutes: number) => number,
  scale: PanelScale
): void {
  ctx.lineWidth = 1.25;
  for (const trace of traces) {
    if (trace.samples.length === 0) continue;
    ctx.strokeStyle = trace.color;
    ctx.beginPath();
    for (let i = 0; i < trace.samples.length; ++i) {
      const s = trace.samples[i]!;
      const x = toX(s.xMinutes);
      const y = scale.toY(s.sigma);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }
}

/** Draw the full chart into the canvas 2D context. */
function drawPlot(
  ctx: CanvasRenderingContext2D,
  canvas: HTMLCanvasElement,
  steps: EkfStepRow[],
  height: number,
  logScale: boolean,
  title: string | undefined
): void {
  const dpr = window.devicePixelRatio || 1;
  const cssWidth =
    canvas.clientWidth || canvas.parentElement?.clientWidth || FALLBACK_WIDTH;
  canvas.width = Math.round(cssWidth * dpr);
  canvas.height = Math.round(height * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  ctx.clearRect(0, 0, cssWidth, height);
  ctx.fillStyle = PLOT_BG;
  ctx.fillRect(0, 0, cssWidth, height);

  const plotX0 = PAD_LEFT;
  const plotX1 = Math.max(PAD_LEFT + 1, cssWidth - PAD_RIGHT);
  const plotY0 = PAD_TOP;
  const plotY1 = Math.max(PAD_TOP + 1, height - PAD_BOTTOM);
  const usableH = Math.max(2, plotY1 - plotY0 - PANEL_GAP);
  const panelH = Math.floor(usableH / 2);
  const posTop = plotY0;
  const posBottom = plotY0 + panelH;
  const velTop = posBottom + PANEL_GAP;
  const velBottom = Math.min(plotY1, velTop + panelH);

  const traces = buildTraces(steps);
  const posTraces = traces.slice(0, 3);
  const velTraces = traces.slice(3, 6);

  // Shared X domain over all samples (both panels align in time).
  let xMaxData = 0;
  for (const trace of traces) {
    for (const s of trace.samples) {
      if (s.xMinutes > xMaxData) xMaxData = s.xMinutes;
    }
  }
  const [xMin, xMax] = paddedDomain(0, xMaxData, 1);
  const toX = (minutes: number) =>
    plotX0 + ((minutes - xMin) / (xMax - xMin)) * (plotX1 - plotX0);

  // Both panels get frames/gridlines/legends even when empty; the empty
  // message replaces the X label so a no-history solve never crashes.
  const posScale = makePanelScale(posTraces, posTop, posBottom, logScale);
  const velScale = makePanelScale(velTraces, velTop, velBottom, logScale);

  drawPanelChrome(ctx, posTraces, plotX0, plotX1, posTop, posBottom, posScale, 'km');
  drawPanelChrome(ctx, velTraces, plotX0, plotX1, velTop, velBottom, velScale, 'km/s');
  drawTraces(ctx, posTraces, toX, posScale);
  drawTraces(ctx, velTraces, toX, velScale);

  // Shared X label (or the empty-state message) under the bottom panel.
  ctx.fillStyle = TEXT_COLOR;
  ctx.font = '10px monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  if (steps.length === 0) {
    ctx.fillText(EMPTY_TEXT, (plotX0 + plotX1) / 2, plotY1 + 4);
  } else {
    ctx.fillText(`${((xMin + xMax) / 2).toFixed(1)} min`, (plotX0 + plotX1) / 2, plotY1 + 4);
  }

  if (title) {
    ctx.fillStyle = TITLE_COLOR;
    ctx.font = '10px monospace';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText(title, plotX0, 3);
  }
}

/**
 * Canvas2D plot of EKF formal covariance sigmas: position x/y/z [km] on a
 * top sub-panel and velocity vx/vy/vz [km/s] on a bottom sub-panel, log
 * scale by default. Accessible via role="img" and a data-driven aria-label.
 */
export function CovariancePlot({
  steps,
  height = 180,
  logScale = true,
  title,
}: CovariancePlotProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const summary = useMemo(() => buildSummary(steps, logScale), [steps, logScale]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const draw = () => drawPlot(ctx, canvas, steps, height, logScale, title);
    draw();

    const observer = new ResizeObserver(() => draw());
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [steps, height, logScale, title]);

  return (
    <canvas
      ref={canvasRef}
      role="img"
      aria-label={summary}
      className="block w-full rounded border border-dust/40"
      style={{ height }}
    />
  );
}
