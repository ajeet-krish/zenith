import { useEffect, useMemo, useRef } from 'react';
import type { EkfStepRow } from '@/orbit/types';

// =============================================================================
// NIS Plot (Phase 4): Canvas2D normalized innovation squared chart
// =============================================================================
// Sequential EKF filter health chart. One point per observation step:
// X = observation time (minutes from arc start), Y = the per-step MAX NIS
// across that step's scalar components (nu^2 / S; a ra_dec step contributes
// RA and Dec, only the larger is drawn for clarity). NIS spans orders of
// magnitude, so Y is log10-scaled with decade gridlines. A dashed neon-red
// gate line marks the chi-square gate (nis_sigma_threshold^2, default 25);
// steps whose plotted component was gated (mask false) are drawn dimmed
// red, updated steps neon-cyan. Maneuver-flagged steps get vertical
// neon-orange markers. Follows the ResidualPlot.tsx canvas pattern.

const NEON_CYAN = '#8be9fd';
const NEON_RED = '#ff5555';
const NEON_ORANGE = '#ffb86c';
const PLOT_BG = '#0d0d12';
const GRID_COLOR = 'rgba(68, 71, 90, 0.35)'; // dust
const AXIS_COLOR = '#44475a'; // dust
const TEXT_COLOR = '#6272a4'; // comment
const TITLE_COLOR = '#f8f8f2';
const EMPTY_TEXT = 'No NIS data';

const GATE_DASH = [5, 3];
const PAD_LEFT = 42;
const PAD_RIGHT = 8;
const PAD_TOP = 16;
const PAD_BOTTOM = 18;
const POINT_RADIUS = 2.5;
const FALLBACK_WIDTH = 300;

/** Smallest plottable NIS; keeps log10 finite for perfect-prediction zeros. */
const NIS_FLOOR = 1e-12;

/** Max decades labeled before gridlines are thinned out. */
const MAX_LABELED_DECADES = 8;

interface NisPlotProps {
  /** Per-step EKF history rows (from an EkfTsResult). */
  steps: EkfStepRow[];
  /** NIS gate threshold (sigma^2 value; default 25 = 5-sigma, 1-dof). */
  gateThreshold?: number;
  /** Canvas height [px]. */
  height?: number;
  /** Draw vertical markers on maneuver-flagged steps. */
  showManeuverMarkers?: boolean;
  /** Optional chart title drawn top-left. */
  title?: string;
}

interface PlottableStep {
  xMinutes: number;
  nis: number;
  updated: boolean;
  maneuver: boolean;
}

/**
 * Per-step plotted value: the max finite NIS across the step's scalar
 * slots, plus whether THAT slot's update was applied (point color) and
 * the step's maneuver flag. Null when the step carries no finite NIS.
 */
function stepMaxNis(step: EkfStepRow): { nis: number; updated: boolean } | null {
  let best: { nis: number; updated: boolean } | null = null;
  for (let i = 0; i < 2; ++i) {
    const v = step.nis[i];
    if (v == null || !Number.isFinite(v)) continue;
    if (!best || v > best.nis) {
      best = { nis: Math.max(v, NIS_FLOOR), updated: step.updatedMask[i] ?? false };
    }
  }
  return best;
}

/** Accessible one-line summary of the step history. */
function buildSummary(
  steps: EkfStepRow[],
  gateThreshold: number
): string {
  if (steps.length === 0) return `NIS plot: ${EMPTY_TEXT.toLowerCase()}`;
  let plotted = 0;
  let gated = 0;
  let maxNis = 0;
  for (const step of steps) {
    const best = stepMaxNis(step);
    if (!best) continue;
    plotted += 1;
    if (!best.updated) gated += 1;
    if (best.nis > maxNis) maxNis = best.nis;
  }
  return (
    `NIS plot: ${steps.length} steps, per-step max NIS on a log scale, ` +
    `${gated} gated above the ${gateThreshold} gate, ` +
    `max NIS ${maxNis.toFixed(2)}, ${plotted} plottable`
  );
}

/** Draw the full chart into the canvas 2D context. */
function drawPlot(
  ctx: CanvasRenderingContext2D,
  canvas: HTMLCanvasElement,
  steps: EkfStepRow[],
  gateThreshold: number,
  height: number,
  showManeuverMarkers: boolean,
  title: string | undefined
): void {
  const dpr = window.devicePixelRatio || 1;
  const cssWidth = canvas.clientWidth || canvas.parentElement?.clientWidth || FALLBACK_WIDTH;
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
  const plotW = plotX1 - plotX0;
  const plotH = plotY1 - plotY0;

  // Build plottable series; X = minutes from the earliest epoch.
  let t0 = steps.length > 0 ? steps[0]!.timeJd : 0;
  for (const step of steps) {
    if (step.timeJd < t0) t0 = step.timeJd;
  }
  const points: PlottableStep[] = [];
  let xMaxData = 0;
  for (const step of steps) {
    const best = stepMaxNis(step);
    if (!best) continue;
    const xMinutes = (step.timeJd - t0) * 1440;
    if (xMinutes > xMaxData) xMaxData = xMinutes;
    points.push({
      xMinutes,
      nis: best.nis,
      updated: best.updated,
      maneuver: step.maneuverFlag,
    });
  }

  // Log10 Y domain: data decades expanded to always include the gate line.
  const gate = Number.isFinite(gateThreshold) && gateThreshold > 0 ? gateThreshold : 25;
  let logMin = Math.floor(Math.log10(gate));
  let logMax = Math.ceil(Math.log10(gate));
  if (points.length > 0) {
    for (const p of points) {
      const l = Math.log10(p.nis);
      if (l < logMin) logMin = Math.floor(l);
      if (l > logMax) logMax = Math.ceil(l);
    }
  }
  if (logMax <= logMin) logMax = logMin + 1;

  const [xMin, xMax] = paddedDomain(0, xMaxData, 1);
  const toX = (minutes: number) => plotX0 + ((minutes - xMin) / (xMax - xMin)) * plotW;
  const toY = (nis: number) =>
    plotY1 - ((Math.log10(Math.max(nis, NIS_FLOOR)) - logMin) / (logMax - logMin)) * plotH;

  // Maneuver markers first (behind gridlines and points).
  if (showManeuverMarkers) {
    ctx.strokeStyle = NEON_ORANGE;
    ctx.globalAlpha = 0.5;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (const p of points) {
      if (!p.maneuver) continue;
      const x = toX(p.xMinutes);
      ctx.moveTo(x, plotY0);
      ctx.lineTo(x, plotY1);
    }
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  // Decade gridlines + labels.
  const decades = logMax - logMin;
  const labelStep = decades > MAX_LABELED_DECADES ? Math.ceil(decades / MAX_LABELED_DECADES) : 1;
  ctx.strokeStyle = GRID_COLOR;
  ctx.lineWidth = 1;
  ctx.font = '10px monospace';
  ctx.fillStyle = TEXT_COLOR;
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  ctx.beginPath();
  for (let k = logMin; k <= logMax; ++k) {
    const y = toY(Math.pow(10, k));
    ctx.moveTo(plotX0, y);
    ctx.lineTo(plotX1, y);
    if ((k - logMin) % labelStep === 0) {
      ctx.fillText(`1e${k}`, plotX0 - 4, y);
    }
  }
  ctx.stroke();

  // Gate line (dashed neon-red).
  const gateY = toY(gate);
  ctx.strokeStyle = NEON_RED;
  ctx.setLineDash(GATE_DASH);
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(plotX0, gateY);
  ctx.lineTo(plotX1, gateY);
  ctx.stroke();
  ctx.setLineDash([]);

  // Points: cyan when the plotted component was updated, dimmed red when gated.
  for (const p of points) {
    const x = toX(p.xMinutes);
    const y = toY(p.nis);
    ctx.fillStyle = p.updated ? NEON_CYAN : NEON_RED;
    if (!p.updated) ctx.globalAlpha = 0.5;
    ctx.beginPath();
    ctx.arc(x, y, POINT_RADIUS, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;
  }

  // Frame + axis labels.
  ctx.strokeStyle = AXIS_COLOR;
  ctx.lineWidth = 1;
  ctx.strokeRect(plotX0, plotY0, plotW, plotH);

  ctx.fillStyle = TEXT_COLOR;
  ctx.font = '10px monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  const midMinutes = (xMin + xMax) / 2;
  ctx.fillText(`${midMinutes.toFixed(1)} min`, toX(midMinutes), plotY1 + 4);

  if (title) {
    ctx.fillStyle = TITLE_COLOR;
    ctx.font = '10px monospace';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText(title, plotX0, 3);
  }
}

/** Guard degenerate Y spans so the log autoscale never divides by zero. */
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
 * Canvas2D log-scale plot of EKF normalized innovation squared (NIS).
 * X = observation time (minutes from arc start), Y = per-step max NIS
 * across scalar components, with a dashed gate line and maneuver markers.
 * Accessible via role="img" and a data-driven aria-label summary.
 */
export function NisPlot({
  steps,
  gateThreshold = 25,
  height = 140,
  showManeuverMarkers = true,
  title,
}: NisPlotProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const summary = useMemo(() => buildSummary(steps, gateThreshold), [steps, gateThreshold]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const draw = () =>
      drawPlot(ctx, canvas, steps, gateThreshold, height, showManeuverMarkers, title);
    draw();

    const observer = new ResizeObserver(() => draw());
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [steps, gateThreshold, height, showManeuverMarkers, title]);

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
