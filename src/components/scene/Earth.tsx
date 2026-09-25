import { useRef, useMemo, Suspense } from 'react';
import { useFrame, useLoader } from '@react-three/fiber';
import { Sphere, Billboard } from '@react-three/drei';
import type { Mesh, Group } from 'three';
import { TextureLoader, CanvasTexture } from 'three';
import { R_EARTH } from '@/orbit/constants';

const SCALE = 1000;
const EARTH_RADIUS = R_EARTH / SCALE;

/**
 * Inner Earth with texture (must be inside Suspense).
 */
function EarthTextured() {
  const earthRef = useRef<Mesh>(null);
  const [diffuseMap] = useLoader(TextureLoader, [
    `${import.meta.env.BASE_URL}textures/earth/diffuse.jpg`,
  ]);

  useFrame((_, delta) => {
    if (earthRef.current) {
      earthRef.current.rotation.y += delta * 0.02;
    }
  });

  return (
    <Sphere ref={earthRef} args={[EARTH_RADIUS, 64, 64]}>
      <meshStandardMaterial
        map={diffuseMap}
        roughness={0.8}
        metalness={0.1}
      />
    </Sphere>
  );
}

/**
 * Fallback Earth while texture loads.
 */
function EarthFallback() {
  const earthRef = useRef<Mesh>(null);

  useFrame((_, delta) => {
    if (earthRef.current) {
      earthRef.current.rotation.y += delta * 0.02;
    }
  });

  return (
    <Sphere ref={earthRef} args={[EARTH_RADIUS, 64, 64]}>
      <meshStandardMaterial
        color="#1a5276"
        roughness={0.8}
        metalness={0.1}
        emissive="#0a2a4a"
        emissiveIntensity={0.15}
      />
    </Sphere>
  );
}

/**
 * Earth - textured sphere with subtle glow.
 *
 * Uses NASA Blue Marble texture (loaded via Suspense with fallback).
 * The existing billboard glow sprite is preserved for atmosphere effect
 * but kept subtle to avoid blocking LEO orbit lines.
 */
export function Earth() {
  const glowRef = useRef<Group>(null);

  // Subtle procedural glow (kept from original - user confirmed it's perfect)
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

  return (
    <group>
      {/* Earth sphere with texture */}
      <Suspense fallback={<EarthFallback />}>
        <EarthTextured />
      </Suspense>

      {/* Subtle atmosphere glow billboard */}
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
