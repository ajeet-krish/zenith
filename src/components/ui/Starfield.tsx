import { useEffect, useRef } from 'react';

interface Star {
  x: number;
  y: number;
  radius: number;
  opacity: number;
  twinkleSpeed: number;
  twinklePhase: number;
}

/**
 * Animated starfield canvas background.
 * Renders twinkling stars that respect prefers-reduced-motion.
 * Ported from Zenith's starfield.js to React.
 */
export function Starfield() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const reducedMotion = window.matchMedia(
      '(prefers-reduced-motion: reduce)',
    ).matches;

    let stars: Star[] = [];
    let animId: number;

    function generate() {
      stars = [];
      const count = window.innerWidth < 640 ? 120 : 250;
      for (let i = 0; i < count; i++) {
        stars.push({
          x: Math.random() * canvas!.width,
          y: Math.random() * canvas!.height,
          radius: Math.random() * 1.2 + 0.3,
          opacity: Math.random() * 0.5 + 0.15,
          twinkleSpeed: Math.random() * 0.003 + 0.001,
          twinklePhase: Math.random() * Math.PI * 2,
        });
      }
    }

    function resize() {
      canvas!.width = window.innerWidth;
      canvas!.height = window.innerHeight;
      generate();
    }

    function draw(time: number) {
      ctx!.clearRect(0, 0, canvas!.width, canvas!.height);
      for (const s of stars) {
        const o = reducedMotion
          ? s.opacity
          : s.opacity *
            (0.7 + 0.3 * Math.sin(time * s.twinkleSpeed + s.twinklePhase));
        ctx!.beginPath();
        ctx!.arc(s.x, s.y, s.radius, 0, Math.PI * 2);
        ctx!.fillStyle = `rgba(168, 180, 208, ${o})`;
        ctx!.fill();
      }
    }

    function animate(time: number) {
      draw(time)
      if (!reducedMotion) animId = requestAnimationFrame(animate);
    }

    window.addEventListener('resize', resize);
    resize();
    if (!reducedMotion) {
      animate(0);
    } else {
      draw(0);
    }

    return () => {
      window.removeEventListener('resize', resize);
      cancelAnimationFrame(animId);
    };
  }, []);

  return <canvas ref={canvasRef} id="starfield-canvas" aria-hidden="true" />;
}
