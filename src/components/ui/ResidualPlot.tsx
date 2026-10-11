import { useEffect, useMemo, useRef } from 'react';
import type { BatchResidualRow } from '@/orbit/types';

// =============================================================================
// Residual Plot (Phase 3): Canvas2D normalized-residual scatter chart
// =============================================================================
// First chart component in the app (no charting dependency). Draws one
// point per residual row: X = observation time (minutes from arc start),
// Y = normalized residual (residual / sigma). Per-obs-type Dracula neon
// colors, a shaded 3-sigma band, a zero line, and red X markers for rows
// edited out of the solution. The kernel emits one row per scalar row, so
// a ra_dec observation contributes two rows (RA and Dec), both drawn in
// the ra_dec color. Follows the Starfield.tsx canvas pattern
// (useRef + useEffect + 2D context) with a ResizeObserver for panel
// resizes.

// Dracula neon colors per observation type (matches Tailwind neon-*).
const OBS_TYPE_COLORS: Record<string, string> = {
  range: '#8be9fd', // neon-cyan
  range_rate: '#bd93f9', // neon-purple
  ra_dec: '#50fa7b', // neon-green
  az_el: '#ffb86c', // neon-orange (defensive; batch never emits AZ_EL)
};

const PLOT_BG = '#0d0d12';
const GRID_COLOR = 'rgba(68, 71, 90, 0.35)'; // dust
const AXIS_COLOR = '#44475a'; // dust
const ZERO_LINE_COLOR = '#6272a4'; // comment
const BAND_FILL = 'rgba(255, 85, 85, 0.08)'; // neon-red, subtle
const BAND_EDGE = 'rgba(255, 85, 85, 0.35)';
const EDITED_COLOR = '#ff5555'; // neon-red
const TEXT_COLOR = '#6272a4'; // comment
const TITLE_COLOR = '#f8f8f2';
const EMPTY_TEXT = 'No residuals';

const SIGMA_BAND = 3;

const PAD_LEFT = 34;
const PAD_RIGHT = 8;
const PAD_TOP = 16;
const PAD_BOTTOM = 18;
const POINT_RADIUS = 3;
const EDITED_ARM = 3.5;
const FALLBACK_WIDTH = 300;

interface ResidualPlotProps {
  /** Residual rows from a batch solve (one point per row, Y = normalized[0]). */
  rows: BatchResidualRow[];
  /** Canvas height [px]. */
  height?: number;
  /** Shade the +/- 3-sigma acceptance band. */
  showSigmaBand?: boolean;
  /** Optional chart title drawn top-left. */
  title?: string;
}

/**
 * Pad a data domain, guarding degenerate spans (single point) so the
 * autoscale never divides by zero.
 */
function paddedDomain(min: number, max: number, minSpan: number): [number, number] {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [0, 1];
  if (max - min < minSpan) {
    const center = (min + max) / 2;
    return [center - minSpan / 2, center + minSpan / 2];
  }
  const pad = (max - min) * 0.05;
  return [min - pad, max + pad];
}

/** Accessible one-line summary of the residual rows. */
function buildSummary(rows: BatchResidualRow[]): string {
  if (rows.length === 0) return `Residual plot: ${EMPTY_TEXT.toLowerCase()}`;
  const edited = rows.filter((r) => r.edited).length;
  let min = Infinity;
  let max = -Infinity;
  for (const row of rows) {
    const v = row.normalized[0] ?? Number.NaN;
    if (!Number.isFinite(v)) continue;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  if (!Number.isFinite(min)) {
    return `Residual plot: ${rows.length} residuals, ${edited} edited`;
  }
  return (
    `Residual plot: ${rows.length} residuals, ${edited} edited, ` +
    `normalized residuals from ${min.toFixed(2)} to ${max.toFixed(2)} sigma`
  );
}

/** Draw the full chart into the canvas 2D context. */
function drawPlot(
  ctx: CanvasRenderingContext2D,
  canvas: HTMLCanvasElement,
  rows: BatchResidualRow[],
  height: number,
  showSigmaBand: boolean,
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

  // X domain: minutes from the earliest row epoch. Y domain: normalized.
  let t0 = 0;
  let xMaxData = 0;
  if (rows.length > 0) {
    t0 = rows[0]!.timeJd;
    for (const row of rows) {
      if (row.timeJd < t0) t0 = row.timeJd;
    }
    for (const row of rows) {
      const minutes = (row.timeJd - t0) * 1440;
      if (minutes > xMaxData) xMaxData = minutes;
    }
  }
  const [xMin, xMax] = paddedDomain(0, xMaxData, 1);

  let yMinData = -SIGMA_BAND;
  let yMaxData = SIGMA_BAND;
  for (const row of rows) {
    const v = row.normalized[0] ?? Number.NaN;
    if (!Number.isFinite(v)) continue;
    if (v < yMinData) yMinData = v;
    if (v > yMaxData) yMaxData = v;
  }
  const [yMin, yMax] = paddedDomain(yMinData, yMaxData, 1);

  const toX = (minutes: number) => plotX0 + ((minutes - xMin) / (xMax - xMin)) * plotW;
  const toY = (norm: number) => plotY1 - ((norm - yMin) / (yMax - yMin)) * plotH;

  // 3-sigma acceptance band (subtle fill + dashed borders).
  if (showSigmaBand) {
    const yTop = toY(SIGMA_BAND);
    const yBot = toY(-SIGMA_BAND);
    ctx.fillStyle = BAND_FILL;
    ctx.fillRect(plotX0, yTop, plotW, yBot - yTop);
    ctx.strokeStyle = BAND_EDGE;
    ctx.setLineDash([4, 3]);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(plotX0, yTop);
    ctx.lineTo(plotX1, yTop);
    ctx.moveTo(plotX0, yBot);
    ctx.lineTo(plotX1, yBot);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  // Light grid at integer sigmas (excluding zero and band edges). Skipped
  // when an outlier dominates the domain and the lines would be too dense.
  if (yMax - yMin <= 20) {
    ctx.strokeStyle = GRID_COLOR;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let sigma = Math.ceil(yMin); sigma <= Math.floor(yMax); ++sigma) {
      if (sigma === 0 || sigma === SIGMA_BAND || sigma === -SIGMA_BAND) continue;
      const y = toY(sigma);
      ctx.moveTo(plotX0, y);
      ctx.lineTo(plotX1, y);
    }
    ctx.stroke();
  }

  // Zero line.
  ctx.strokeStyle = ZERO_LINE_COLOR;
  ctx.beginPath();
  ctx.moveTo(plotX0, toY(0));
  ctx.lineTo(plotX1, toY(0));
  ctx.stroke();

  // Points: filled circles for active rows, red X for edited rows.
  ctx.lineWidth = 1.5;
  for (const row of rows) {
    const norm = row.normalized[0] ?? Number.NaN;
    if (!Number.isFinite(norm)) continue;
    const x = toX((row.timeJd - t0) * 1440);
    const y = toY(norm);
    if (row.edited) {
      ctx.strokeStyle = EDITED_COLOR;
      ctx.globalAlpha = 0.5;
      ctx.beginPath();
      ctx.moveTo(x - EDITED_ARM, y - EDITED_ARM);
      ctx.lineTo(x + EDITED_ARM, y + EDITED_ARM);
      ctx.moveTo(x + EDITED_ARM, y - EDITED_ARM);
      ctx.lineTo(x - EDITED_ARM, y + EDITED_ARM);
      ctx.stroke();
      ctx.globalAlpha = 1;
    } else {
      ctx.fillStyle = OBS_TYPE_COLORS[row.obsType] ?? TITLE_COLOR;
      ctx.beginPath();
      ctx.arc(x, y, POINT_RADIUS, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // Frame + axis ticks and labels (canvas monospace 10px).
  ctx.strokeStyle = AXIS_COLOR;
  ctx.lineWidth = 1;
  ctx.strokeRect(plotX0, plotY0, plotW, plotH);

  ctx.fillStyle = TEXT_COLOR;
  ctx.font = '10px monospace';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  for (const sigma of [SIGMA_BAND, 0, -SIGMA_BAND]) {
    if (sigma < yMin || sigma > yMax) continue;
    const y = toY(sigma);
    ctx.fillText(String(sigma), plotX0 - 4, y);
    ctx.beginPath();
    ctx.moveTo(plotX0 - 3, y);
    ctx.lineTo(plotX0, y);
    ctx.stroke();
  }

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

/**
 * Canvas2D scatter plot of batch OD post-fit residuals.
 * X = observation time (minutes from arc start), Y = normalized residual
 * (residual / sigma) with a shaded 3-sigma band. Accessible via role="img"
 * and a data-driven aria-label summary.
 */
export function ResidualPlot({
  rows,
  height = 140,
  showSigmaBand = true,
  title,
}: ResidualPlotProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const summary = useMemo(() => buildSummary(rows), [rows]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const draw = () => drawPlot(ctx, canvas, rows, height, showSigmaBand, title);
    draw();

    const observer = new ResizeObserver(() => draw());
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [rows, height, showSigmaBand, title]);

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
