import { useRef, useMemo } from 'react';
import { useFrame } from '@react-three/fiber';
import { Sphere, Billboard } from '@react-three/drei';
import type { Mesh, Group } from 'three';
import { CanvasTexture } from 'three';
import { R_EARTH } from '@/orbit/constants';

/**
 * Scene scale: 1 unit = 1000 km.
 * Earth radius becomes ~6.378 units.
 */
const SCALE = 1000;
const EARTH_RADIUS = R_EARTH / SCALE;

/**
 * Earth - styled sphere with atmosphere glow.
 *
 * Renders a dark-themed Earth at the origin with slow axial rotation
 * and a billboarded glow sprite for atmosphere effect.
 */
export function Earth() {
  const earthRef = useRef<Mesh>(null);
  const glowRef = useRef<Group>(null);

  // Procedural Earth glow texture (radial gradient billboard)
  const glowTexture = useMemo(() => {
    const size = 256;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;

    const center = size / 2;
    const gradient = ctx.createRadialGradient(center, center, 0, center, center, center);
    gradient.addColorStop(0, 'rgba(80, 160, 255, 0.35)');
    gradient.addColorStop(0.3, 'rgba(50, 130, 255, 0.12)');
    gradient.addColorStop(0.7, 'rgba(30, 90, 255, 0.04)');
    gradient.addColorStop(1, 'rgba(0, 50, 200, 0)');

    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, size, size);

    const tex = new CanvasTexture(canvas);
    tex.needsUpdate = true;
    return tex;
  }, []);

  // Slow axial rotation
  useFrame((_, delta) => {
    if (earthRef.current) {
      earthRef.current.rotation.y += delta * 0.02;
    }
  });

  return (
    <group>
      {/* Earth sphere */}
      <Sphere ref={earthRef} args={[EARTH_RADIUS, 64, 64]}>
        <meshStandardMaterial
          color="#1a5276"
          roughness={0.8}
          metalness={0.1}
          emissive="#0a2a4a"
          emissiveIntensity={0.15}
        />
      </Sphere>

      {/* Atmosphere glow billboard */}
      {glowTexture && (
        <Billboard ref={glowRef} follow={true}>
          <mesh>
            <planeGeometry args={[EARTH_RADIUS * 3.2, EARTH_RADIUS * 3.2]} />
            <meshBasicMaterial
              map={glowTexture}
              transparent
              depthWrite={false}
              blending={2}
            />
          </mesh>
        </Billboard>
      )}
    </group>
  );
}
