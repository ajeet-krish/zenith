import { useMemo } from 'react';
import { Line } from '@react-three/drei';
import { useAnalysisStore } from '@/store/useAnalysisStore';
import { R_EARTH } from '@/orbit/constants';

const SCALE = 1000;

/**
 * TransferOrbitPath - renders a dashed Hohmann transfer orbit overlay.
 *
 * Computes the elliptical transfer arc between initial and target altitudes
 * and renders it as a dashed line in the orbital plane.
 */
export function TransferOrbitPath() {
  const maneuverResult = useAnalysisStore((s) => s.maneuverResult);
  const alt1Km = useAnalysisStore((s) => s.maneuverAlt1Km);

  const points = useMemo(() => {
    if (!maneuverResult) return null;

    const r1 = R_EARTH + alt1Km;
    const aT = maneuverResult.aTransfer;
    const eT = (maneuverResult.aTransfer - r1) / maneuverResult.aTransfer;

    const pts: [number, number, number][] = [];
    const numPoints = 180;

    for (let i = 0; i <= numPoints; i++) {
      const nu = (i / numPoints) * Math.PI; // Half ellipse for Hohmann
      const r = (aT * (1 - eT * eT)) / (1 + eT * Math.cos(nu));

      // Position in orbital plane (assuming equatorial for simplicity)
      const x = (r * Math.cos(nu)) / SCALE;
      const y = 0;
      const z = (-r * Math.sin(nu)) / SCALE;

      pts.push([x, y, z]);
    }

    return pts;
  }, [maneuverResult, alt1Km]);

  if (!points) return null;

  return (
    <Line
      points={points}
      color="#ffb86c"
      lineWidth={1.5}
      dashed
      dashSize={0.1}
      gapSize={0.05}
      transparent
      opacity={0.7}
    />
  );
}
