import { useRef, useMemo, Suspense } from 'react';
import { useFrame, useLoader } from '@react-three/fiber';
import { Sphere } from '@react-three/drei';
import type { Mesh } from 'three';
import { TextureLoader, DoubleSide, ShaderMaterial as ThreeShaderMaterial } from 'three';
import { R_EARTH } from '@/orbit/constants';

const SCALE = 1000;
const EARTH_RADIUS = R_EARTH / SCALE;

/**
 * Fresnel atmosphere vertex shader.
 */
const atmosphereVertexShader = `
  varying vec3 vNormal;
  varying vec3 vViewDir;
  void main() {
    vNormal = normalize(normalMatrix * normal);
    vec4 mvPos = modelViewMatrix * vec4(position, 1.0);
    vViewDir = normalize(-mvPos.xyz);
    gl_Position = projectionMatrix * mvPos;
  }
`;

/**
 * Fresnel atmosphere fragment shader.
 */
const atmosphereFragmentShader = `
  uniform vec3 uSunDir;
  uniform vec3 uGlowColor;
  varying vec3 vNormal;
  varying vec3 vViewDir;
  void main() {
    float fresnel = pow(1.0 - dot(vNormal, vViewDir), 3.0);
    float sunFactor = max(dot(vNormal, uSunDir), 0.0);
    vec3 color = uGlowColor * fresnel * (0.5 + 0.5 * sunFactor);
    gl_FragColor = vec4(color, fresnel * 0.6);
  }
`;

/**
 * Inner Earth component that loads textures (must be inside Suspense).
 */
function EarthInner() {
  const earthRef = useRef<Mesh>(null);
  const cloudsRef = useRef<Mesh>(null);

  const textureBase = `${import.meta.env.BASE_URL}textures/earth/`;

  const [diffuseMap, nightMap, cloudsMap] = useLoader(TextureLoader, [
    `${textureBase}diffuse.jpg`,
    `${textureBase}night.jpg`,
    `${textureBase}clouds.png`,
  ]);

  // Atmosphere shader material
  const atmosphereMaterial = useMemo(() => {
    return new ThreeShaderMaterial({
      vertexShader: atmosphereVertexShader,
      fragmentShader: atmosphereFragmentShader,
      uniforms: {
        uSunDir: { value: [1, 0.3, 0.5] },
        uGlowColor: { value: [0.3, 0.6, 1.0] },
      },
      transparent: true,
      side: DoubleSide,
      depthWrite: false,
    });
  }, []);

  // Slow axial rotation
  useFrame((_, delta) => {
    if (earthRef.current) {
      earthRef.current.rotation.y += delta * 0.02;
    }
    if (cloudsRef.current) {
      cloudsRef.current.rotation.y += delta * 0.025;
    }
  });

  return (
    <group>
      {/* Earth sphere with diffuse texture */}
      <Sphere ref={earthRef} args={[EARTH_RADIUS, 64, 64]}>
        <meshStandardMaterial
          map={diffuseMap}
          emissiveMap={nightMap}
          emissive="#ffaa44"
          emissiveIntensity={0.3}
          roughness={0.8}
          metalness={0.1}
        />
      </Sphere>

      {/* Cloud layer */}
      <Sphere ref={cloudsRef} args={[EARTH_RADIUS * 1.005, 64, 64]}>
        <meshStandardMaterial
          map={cloudsMap}
          transparent
          opacity={0.3}
          depthWrite={false}
          side={DoubleSide}
        />
      </Sphere>

      {/* Fresnel atmosphere glow */}
      <Sphere args={[EARTH_RADIUS * 1.08, 64, 64]} material={atmosphereMaterial} />
    </group>
  );
}

/**
 * Fallback Earth shown while textures load.
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
 * Earth - textured planet with atmosphere.
 *
 * Wraps textured Earth in Suspense so the scene renders immediately
 * with a fallback blue sphere, then upgrades to textured Earth when
 * NASA Blue Marble textures finish loading.
 */
export function Earth() {
  return (
    <Suspense fallback={<EarthFallback />}>
      <EarthInner />
    </Suspense>
  );
}
