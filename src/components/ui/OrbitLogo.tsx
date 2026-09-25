/**
 * OrbitLogo - SVG orbit icon for the Zenith navbar.
 */
export function OrbitLogo({ className = '' }: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="256"
      height="256"
      viewBox="0 0 256 256"
      fill="none"
      className={className}
    >
      {/* Orbiting body */}
      <circle
        cx="208"
        cy="48"
        r="32"
        stroke="#bd93f9"
        strokeWidth="9"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {/* Outer orbit path */}
      <path
        d="M 226.27 74.28 A 112.01 112.01 0 0 1 195.14 217.67 112.01 112.01 0 0 1 48.77 207.21 112.01 112.01 0 0 1 38.35 60.85 112.01 112.01 0 0 1 181.75 29.74"
        stroke="#bd93f9"
        strokeWidth="9"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
      {/* Inner orbit path */}
      <path
        d="M 219.64 191.62 A 112.01 112.01 0 0 0 127.86 144.02 112.01 112.01 0 0 0 36.20 191.83"
        stroke="#bd93f9"
        strokeWidth="9"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
    </svg>
  );
}
