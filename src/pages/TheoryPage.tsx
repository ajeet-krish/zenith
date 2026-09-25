import { useEffect, useRef } from 'react';
import katex from 'katex';
import 'katex/dist/katex.min.css';

/**
 * Renders a LaTeX string as inline HTML.
 */
function InlineMath({ tex }: { tex: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (ref.current) {
      katex.render(tex, ref.current, { throwOnError: false });
    }
  }, [tex]);
  return <span ref={ref} className="text-neon-cyan" />;
}

/**
 * Renders a LaTeX string as a display (block) equation.
 */
function BlockMath({ tex }: { tex: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (ref.current) {
      katex.render(tex, ref.current, { throwOnError: false, displayMode: true });
    }
  }, [tex]);
  return <div ref={ref} className="my-4 text-center overflow-x-auto" />;
}

/**
 * Reusable section heading with anchor id.
 */
function H2({ id, children }: { id: string; children: React.ReactNode }) {
  return (
    <h2 id={id} className="text-lg font-mono font-bold text-white mt-10 mb-4 border-b border-dust pb-2 scroll-mt-4">
      {children}
    </h2>
  );
}

function H3({ id, children }: { id?: string; children: React.ReactNode }) {
  return (
    <h3 id={id} className="text-sm font-mono font-semibold text-neon-purple mt-6 mb-2 scroll-mt-4">
      {children}
    </h3>
  );
}

function P({ children }: { children: React.ReactNode }) {
  return <p className="text-sm font-mono text-space-300 leading-relaxed mb-3">{children}</p>;
}

function Note({ children }: { children: React.ReactNode }) {
  return (
    <div className="bg-neon-purple/5 border border-neon-purple/20 rounded px-4 py-3 my-4 text-xs font-mono text-space-300">
      <span className="text-neon-purple font-semibold">Note: </span>{children}
    </div>
  );
}

/**
 * Table of contents entry.
 */
interface TOCEntry {
  id: string;
  label: string;
  sub?: { id: string; label: string }[];
}

const TOC: TOCEntry[] = [
  { id: 'what-is-zenith', label: 'What is Zenith?' },
  {
    id: 'orbital-mechanics', label: '1. Orbital Mechanics',
    sub: [
      { id: 'two-body', label: 'Two-Body Problem' },
      { id: 'keplerian-elements', label: 'Keplerian Elements' },
      { id: 'vis-viva', label: 'Vis-Viva Equation' },
      { id: 'orbital-period', label: 'Orbital Period' },
    ],
  },
  {
    id: 'propagation', label: '2. Propagation Methods',
    sub: [
      { id: 'sgp4', label: 'SGP4' },
      { id: 'kepler-prop', label: 'Kepler' },
      { id: 'rk45', label: 'RK45' },
    ],
  },
  {
    id: 'force-models', label: '3. Force Models',
    sub: [
      { id: 'j2', label: 'J2 Oblateness' },
      { id: 'drag', label: 'Atmospheric Drag' },
      { id: 'srp', label: 'Solar Radiation' },
      { id: 'third-body', label: 'Third-Body Gravity' },
    ],
  },
  {
    id: 'tool-interface', label: '4. Tool Interface',
    sub: [
      { id: '3d-scene', label: '3D Scene' },
      { id: 'left-sidebar', label: 'Left Sidebar' },
      { id: 'right-sidebar', label: 'Right Sidebar' },
      { id: 'overlay-panels', label: 'Overlay Panels' },
    ],
  },
  {
    id: 'analysis-tools', label: '5. Analysis Tools',
    sub: [
      { id: 'hohmann', label: 'Hohmann Transfer' },
      { id: 'lambert', label: 'Lambert Solver' },
      { id: 'ground-track', label: 'Ground Track' },
      { id: 'conjunction', label: 'Conjunction Screening' },
      { id: 'pass-predictor', label: 'Pass Predictor' },
      { id: 'monte-carlo', label: 'Monte Carlo' },
      { id: 'walker', label: 'Walker Constellation' },
    ],
  },
];

/**
 * Table of Contents sidebar.
 */
function TableOfContents() {
  return (
    <nav className="w-56 shrink-0 border-r border-dust bg-[#0d0d12] overflow-y-auto py-6 px-4">
      <div className="text-[10px] font-mono text-comment uppercase tracking-wider mb-4">
        On this page
      </div>
      <ul className="space-y-1">
        {TOC.map((entry) => (
          <li key={entry.id}>
            <a
              href={`#${entry.id}`}
              className="block text-[11px] font-mono text-space-300 hover:text-neon-purple transition-colors py-0.5"
            >
              {entry.label}
            </a>
            {entry.sub && (
              <ul className="ml-3 mt-0.5 space-y-0.5 border-l border-dust pl-3">
                {entry.sub.map((sub) => (
                  <li key={sub.id}>
                    <a
                      href={`#${sub.id}`}
                      className="block text-[10px] font-mono text-comment hover:text-neon-purple transition-colors py-0.5"
                    >
                      {sub.label}
                    </a>
                  </li>
                ))}
              </ul>
            )}
          </li>
        ))}
      </ul>
    </nav>
  );
}

/**
 * TheoryPage - Orbital mechanics reference and tool usage guide.
 */
export function TheoryPage() {
  return (
    <div className="flex-1 flex overflow-hidden bg-void text-white">
      {/* Table of Contents sidebar */}
      <TableOfContents />

      {/* Main content */}
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-3xl mx-auto px-6 py-10">
        <h1 className="text-2xl font-mono font-bold text-white mb-2">
          Orbital Mechanics & Tool Guide
        </h1>
        <p className="text-sm font-mono text-comment mb-8">
          A reference for the propagation methods, force models, and analysis tools in Zenith.
        </p>

        {/* ================================================================= */}
        {/* INTRO */}
        {/* ================================================================= */}
          <H2 id="what-is-zenith">What is Zenith?</H2>
        <P>
          Zenith is an open-source, browser-based orbital mechanics toolkit for satellite mission
          analysis and visualization. It propagates satellite orbits in real time using a C++ WASM
          backend (with a pure TypeScript fallback), renders them in an interactive 3D scene, and
          provides a suite of analysis tools for mission planning.
        </P>
        <P>
          You can load satellites from Two-Line Element sets, visualize their orbits around Earth,
          solve Lambert problems, predict ground station passes, compute Hohmann transfers, generate
          ground tracks, screen for conjunctions over time windows, run Monte Carlo uncertainty
          analyses, and design Walker Delta constellations, all from your browser.
        </P>
        <div className="bg-card-surface border border-dust rounded p-4 my-4 text-xs font-mono">
          <a
            href="https://github.com/ajeet-krish/zenith"
            target="_blank"
            rel="noopener noreferrer"
            className="text-neon-purple hover:text-neon-cyan transition-colors"
          >
            github.com/ajeet-krish/zenith
          </a>
          <span className="text-comment ml-2">- source code, issues, and contributions</span>
        </div>

        {/* ================================================================= */}
        {/* 1. ORBITAL MECHANICS BASICS */}
        {/* ================================================================= */}
          <H2 id="orbital-mechanics">1. Orbital Mechanics Basics</H2>

        <H3 id="two-body">The Two-Body Problem</H3>
        <P>
          Classical orbital mechanics begins with the two-body problem: predicting the motion of two
          point masses under their mutual gravitational attraction. For a satellite of mass{' '}
          <InlineMath tex="m" /> orbiting Earth of mass <InlineMath tex="M" />, the equation of
          motion is:
        </P>
        <BlockMath tex="\ddot{\mathbf{r}} = -\frac{\mu}{r^3}\mathbf{r}" />
        <P>
          where <InlineMath tex="\mathbf{r}" /> is the position vector from Earth's center,{' '}
          <InlineMath tex="r = |\mathbf{r}|" /> is the radial distance, and{' '}
          <InlineMath tex="\mu = GM" /> is Earth's gravitational parameter
          (<InlineMath tex="\mu \approx 398600.4418 \; \text{km}^3/\text{s}^2" />
          ).
        </P>

        <H3 id="keplerian-elements">Keplerian Orbital Elements</H3>
        <P>
          Any Keplerian orbit (two-body, no perturbations) is fully described by six classical
          elements:
        </P>
        <div className="bg-card-surface border border-dust rounded p-4 my-4 space-y-1 text-xs font-mono">
          <div>
            <span className="text-neon-cyan">a</span> - Semi-major axis: size of the orbit (km)
          </div>
          <div>
            <span className="text-neon-cyan">e</span> - Eccentricity: shape of the orbit (0 = circle,
            0-1 = ellipse)
          </div>
          <div>
            <span className="text-neon-cyan">i</span> - Inclination: tilt relative to the equatorial
            plane (deg)
          </div>
          <div>
            <span className="text-neon-cyan">&Omega;</span> - RAAN (Right Ascension of the Ascending
            Node): orientation of the orbital plane (deg)
          </div>
          <div>
            <span className="text-neon-cyan">&omega;</span> - Argument of perigee: orientation of the
            ellipse within the orbital plane (deg)
          </div>
          <div>
            <span className="text-neon-cyan">&nu;</span> - True anomaly: current position along the
            orbit (deg)
          </div>
        </div>

        <H3 id="vis-viva">Vis-Viva Equation</H3>
        <P>
          The vis-viva equation relates orbital velocity to position for any Keplerian orbit:
        </P>
        <BlockMath tex="v = \sqrt{\mu\left(\frac{2}{r} - \frac{1}{a}\right)}" />
        <P>
          This is fundamental: given a satellite's distance <InlineMath tex="r" /> and semi-major axis{' '}
          <InlineMath tex="a" />, you can compute its speed. At perigee (closest approach), velocity is
          maximum; at apogee (farthest point), velocity is minimum.
        </P>

        <H3 id="orbital-period">Orbital Period</H3>
        <P>
          Kepler's third law gives the orbital period from the semi-major axis:
        </P>
        <BlockMath tex="T = 2\pi\sqrt{\frac{a^3}{\mu}}" />
        <P>
          For example, a circular orbit at 400 km altitude (a = 6771 km) has a period of approximately
          92.5 minutes, typical for the International Space Station.
        </P>

        {/* ================================================================= */}
        {/* 2. PROPAGATION METHODS */}
        {/* ================================================================= */}
          <H2 id="propagation">2. Propagation Methods</H2>
        <P>
          Orbital propagation is the process of predicting a satellite's position and velocity at a
          future time. Zenith offers three propagation methods with increasing fidelity.
        </P>

        <H3 id="sgp4">SGP4 (Simplified General Perturbations)</H3>
        <P>
          SGP4 is the standard analytical propagator used by NORAD and the US Space Force for
          tracking cataloged objects. It uses Two-Line Element sets (TLEs) as input and accounts for
          the dominant perturbations analytically:
        </P>
        <ul className="list-disc list-inside text-sm font-mono text-space-300 mb-3 space-y-1">
          <li>Earth's oblateness (J2, J3, J4 harmonics)</li>
          <li>Atmospheric drag (using a simple density model)</li>
          <li>Lunar and solar gravitational effects (via deep-space correction terms)</li>
        </ul>
        <P>
          SGP4 propagates in the True Equator, Mean Equinox (TEME) coordinate frame. It is fast and
          suitable for tracking debris, cataloged satellites, and conjunction screening. However, it
          accumulates error over time, typically degrading after 30-60 days from the TLE epoch.
        </P>
        <Note>
          TLEs are mean elements, not osculating elements. They encode averaged orbital behavior and
          must be used with the SGP4 model specifically - using them with other propagators will
          produce incorrect results.
        </Note>

        <H3 id="kepler-prop">Kepler (Two-Body)</H3>
        <P>
          The Kepler propagator solves the exact two-body problem using Kepler's equation:
        </P>
        <BlockMath tex="M = E - e\sin E" />
        <P>
          where <InlineMath tex="M" /> is the mean anomaly, <InlineMath tex="E" /> is the eccentric
          anomaly, and <InlineMath tex="e" /> is the eccentricity. This is solved iteratively via
          Newton-Raphson:
        </P>
        <BlockMath tex="E_{n+1} = E_n - \frac{E_n - e\sin E_n - M}{1 - e\cos E_n}" />
        <P>
          Once <InlineMath tex="E" /> is found, the true anomaly <InlineMath tex="\nu" /> and position
          follow from:
        </P>
        <BlockMath tex="\tan\frac{\nu}{2} = \sqrt{\frac{1+e}{1-e}}\tan\frac{E}{2}" />
        <P>
          This method ignores all perturbations, so it is only accurate for short time spans or
          orbits where perturbations are negligible. It serves as a fast baseline and is always
          available as a fallback when WASM is not loaded.
        </P>

        <H3 id="rk45">RK45 (Numerical Integration)</H3>
        <P>
          The RK45 method uses a Runge-Kutta-Fehlberg adaptive integrator to solve the equations of
          motion numerically. Unlike analytical methods, it can incorporate arbitrary force models by
          evaluating the acceleration at each sub-step:
        </P>
        <BlockMath tex="\dot{\mathbf{x}} = f(t, \mathbf{x})" />
        <P>
          where <InlineMath tex="\mathbf{x} = [\mathbf{r}, \mathbf{v}]^T" /> is the state vector
          (position + velocity). The RK45 integrator uses six function evaluations per step with
          adaptive step-size control, balancing accuracy and computational cost.
        </P>
        <P>
          RK45 is the most accurate method available in Zenith. It is required when using advanced
          force models (J2 corrections, drag, SRP, third-body) and provides osculating element output.
          The trade-off is higher computational cost.
        </P>

        {/* ================================================================= */}
        {/* 3. FORCE MODELS */}
        {/* ================================================================= */}
          <H2 id="force-models">3. Force Models</H2>
        <P>
          Force models account for perturbations that deviate from ideal two-body motion. These can
          be toggled in the Propagation panel when using the RK45 integrator.
        </P>

        <H3 id="j2">J2 Oblateness Correction</H3>
        <P>
          Earth is not a perfect sphere - it bulges at the equator due to its rotation. The J2
          coefficient captures the dominant oblateness effect. The additional acceleration is:
        </P>
        <BlockMath tex="\mathbf{a}_{J2} = -\frac{3}{2}J_2\frac{\mu R_E^2}{r^5}\begin{bmatrix} x(5z^2/r^2 - 1) \\ y(5z^2/r^2 - 1) \\ z(5z^2/r^2 - 3) \end{bmatrix}" />
        <P>
          where <InlineMath tex="J_2 \approx 1.08263 \times 10^{-3}" /> and{' '}
          <InlineMath tex="R_E = 6378.137" /> km is Earth's equatorial radius. J2 causes two main
          effects: regression of the ascending node (RAAN drift) and rotation of the line of apsides
          (argument of perigee drift).
        </P>
        <Note>
          SGP4 already includes J2, J3, and J4 internally. The J2 force model toggle applies
          additional corrections when using the RK45 numerical integrator.
        </Note>

        <H3 id="drag">Atmospheric Drag</H3>
        <P>
          For satellites in Low Earth Orbit (LEO, typically below 1000 km), atmospheric drag is the
          dominant perturbation. The drag acceleration is:
        </P>
        <BlockMath tex="\mathbf{a}_{\text{drag}} = -\frac{1}{2}\frac{C_D A}{m}\rho v_{\text{rel}}\,\mathbf{v}_{\text{rel}}" />
        <P>
          where <InlineMath tex="C_D" /> is the drag coefficient (typically 2.2),{' '}
          <InlineMath tex="A/m" /> is the area-to-mass ratio,{' '}
          <InlineMath tex="\rho" /> is the atmospheric density, and{' '}
          <InlineMath tex="\mathbf{v}_{\text{rel}}" /> is the velocity relative to the co-rotating
          atmosphere. Drag causes orbit decay, reducing semi-major axis and eccentricity over time.
        </P>

        <H3 id="srp">Solar Radiation Pressure (SRP)</H3>
        <P>
          Photons from the Sun exert a small but continuous force on the satellite. The SRP
          acceleration is:
        </P>
        <BlockMath tex="\mathbf{a}_{\text{SRP}} = -\frac{P_{\odot} C_R A}{m}\hat{\mathbf{r}}_{\odot}" />
        <P>
          where <InlineMath tex="P_\odot \approx 4.56 \times 10^{-6}" /> N/m^2 is the solar radiation
          pressure at 1 AU, <InlineMath tex="C_R" /> is the reflectivity coefficient (1 = absorbed, 2
          = perfectly reflected), and <InlineMath tex="\hat{\mathbf{r}}_\odot" /> is the unit vector
          toward the Sun. SRP is most significant for satellites with high area-to-mass ratios, such
          as those with large solar panels (MEO and GEO orbits).
        </P>

        <H3 id="third-body">Third-Body Gravity (Lunar/Solar)</H3>
        <P>
          The gravitational influence of the Moon and Sun perturbs the orbit, especially for high-
          altitude satellites. The third-body acceleration from a perturbing body is:
        </P>
        <BlockMath tex="\mathbf{a}_{3\text{rd}} = \mu_p\left(\frac{\mathbf{r}_p - \mathbf{r}}{|\mathbf{r}_p - \mathbf{r}|^3} - \frac{\mathbf{r}_p}{|\mathbf{r}_p|^3}\right)" />
        <P>
          where <InlineMath tex="\mu_p" /> and <InlineMath tex="\mathbf{r}_p" /> are the
          gravitational parameter and position of the perturbing body (Moon or Sun), and{' '}
          <InlineMath tex="\mathbf{r}" /> is the satellite position. The second term removes the
          uniform acceleration component (Earth is also accelerating toward the perturbing body).
        </P>

        {/* ================================================================= */}
        {/* 4. UNDERSTANDING THE TOOL INTERFACE */}
        {/* ================================================================= */}
          <H2 id="tool-interface">4. Understanding the Tool Interface</H2>

        <H3 id="3d-scene">The 3D Scene</H3>
        <P>
          The center of the screen displays a Three.js 3D visualization of the orbital environment.
          The Earth is rendered with a realistic texture, and satellites are shown as colored markers
          based on their category (LEO, MEO, GEO, HEO, debris). The coordinate system uses TEME
          (True Equator, Mean Equinox) with km/1000 scaling for the scene.
        </P>
        <div className="bg-card-surface border border-dust rounded p-4 my-4 text-xs font-mono space-y-1">
          <div><span className="text-neon-cyan">Left drag</span> - Rotate the view</div>
          <div><span className="text-neon-cyan">Right drag</span> - Pan the camera</div>
          <div><span className="text-neon-cyan">Scroll</span> - Zoom in/out</div>
          <div><span className="text-neon-cyan">Click satellite</span> - Select and view details</div>
        </div>

        <H3 id="left-sidebar">Left Sidebar - Satellite List</H3>
        <P>
          Shows all loaded satellites with their name, NORAD catalog number, and orbit category.
          Click a satellite to select it and view detailed orbital information. The visibility toggle
          (eye icon) controls whether the satellite and its orbit path appear in the 3D scene. Use
          the TLE Input button to add satellites from Two-Line Element sets.
        </P>

        <H3 id="right-sidebar">Right Sidebar - Analysis Tools</H3>
        <P>
          The right panel contains vertically stacked collapsible sections (modeled after the Zenith
          desktop layout). Multiple analysis sections can be open simultaneously:
        </P>
        <ul className="list-disc list-inside text-sm font-mono text-space-300 mb-3 space-y-1">
          <li>
            <span className="text-neon-purple">Maneuver</span> - Hohmann transfer delta-V planning
          </li>
          <li>
            <span className="text-neon-purple">Lambert</span> - Solve Lambert's problem for trajectory design
          </li>
          <li>
            <span className="text-neon-purple">Ground Track</span> - Sub-satellite point visualization
          </li>
          <li>
            <span className="text-neon-purple">Conjunction</span> - Single-epoch and time-window screening
          </li>
          <li>
            <span className="text-neon-purple">Pass Predictor</span> - Ground station pass prediction
          </li>
          <li>
            <span className="text-neon-purple">Monte Carlo</span> - Uncertainty propagation
          </li>
          <li>
            <span className="text-neon-purple">Walker Constellation</span> - Multi-plane constellation design
          </li>
        </ul>

        <H3 id="overlay-panels">Overlay Panels</H3>
        <P>
          Floating panels appear on the 3D scene: Time Controls (top-right) for playback and speed
          control, and Satellite Info (top-left) showing Keplerian elements and state vectors when a
          satellite is selected.
        </P>

        {/* ================================================================= */}
        {/* 5. ANALYSIS TOOLS */}
        {/* ================================================================= */}
          <H2 id="analysis-tools">5. Analysis Tools</H2>

        <H3 id="hohmann">Hohmann Transfer</H3>
        <P>
          The Hohmann transfer is the most fuel-efficient two-impulse maneuver for changing circular
          orbits in the same plane. It uses an elliptical transfer orbit tangent to both the initial
          and target orbits.
        </P>
        <P>The velocity changes required at each burn are:</P>
        <BlockMath tex="\Delta v_1 = \sqrt{\frac{\mu}{r_1}}\left(\sqrt{\frac{2r_2}{r_1+r_2}} - 1\right)" />
        <BlockMath tex="\Delta v_2 = \sqrt{\frac{\mu}{r_2}}\left(1 - \sqrt{\frac{2r_1}{r_1+r_2}}\right)" />
        <P>
          where <InlineMath tex="r_1" /> and <InlineMath tex="r_2" /> are the radii of the initial and
          target orbits. The transfer time is exactly half the period of the transfer ellipse:
        </P>
        <BlockMath tex="t_{\text{transfer}} = \pi\sqrt{\frac{(r_1+r_2)^3}{8\mu}}" />
        <P>
          Enter the initial and target altitudes (in km above Earth's surface) and click Compute
          Transfer to see the burn magnitudes and transfer duration. The tool uses the vis-viva
          equation and Hohmann geometry to compute exact delta-V requirements.
        </P>

        <H3 id="lambert">Lambert Solver</H3>
        <P>
          Lambert's problem determines the orbit connecting two position vectors in a given time of
          flight. Given departure position <InlineMath tex="\mathbf{r}_1" />, arrival position{' '}
          <InlineMath tex="\mathbf{r}_2" />, and time of flight{' '}
          <InlineMath tex="\Delta t" />, the solver finds the velocity vectors at both points.
        </P>
        <P>
          This is essential for interplanetary transfer design, rendezvous planning, and orbit
          determination from angles-only observations. The solver uses the universal variable
          formulation and iterates on the Stumpff functions to find the transfer orbit.
        </P>
        <P>
          Enter departure and arrival positions (in TEME km) and the time of flight (in seconds).
          The solver returns the velocity vectors at both endpoints and indicates convergence.
        </P>

        <H3 id="ground-track">Ground Track</H3>
        <P>
          A ground track is the projection of a satellite's orbit onto Earth's surface. Because Earth
          rotates beneath the orbit, the ground track shifts westward each orbit. The shift depends
          on the orbital period and Earth's rotation rate (approximately 360 deg/day).
        </P>
        <P>
          The ground track is computed by propagating the satellite's position in TEME coordinates and
          converting to geodetic latitude and longitude at each time step. The result shows the path
          the satellite traces over the ground, which is essential for:
        </P>
        <ul className="list-disc list-inside text-sm font-mono text-space-300 mb-3 space-y-1">
          <li>Communication window planning (when the satellite is above a ground station)</li>
          <li>Earth observation mission design (coverage of specific regions)</li>
          <li>Understanding orbit repeat patterns</li>
        </ul>
        <P>
          Set the duration in days and click Compute Ground Track. Toggle the ON/OFF switch to show or
          hide the ground track line on the 3D globe.
        </P>

        <H3 id="conjunction">Conjunction Screening</H3>
        <P>
          Conjunction screening checks for close approaches between all pairs of loaded satellites at
          the current epoch. The miss distance between each pair is computed as:
        </P>
        <BlockMath tex="d = \sqrt{(x_1-x_2)^2 + (y_1-y_2)^2 + (z_1-z_2)^2}" />
        <P>
          Events are classified by risk level based on miss distance:
        </P>
        <div className="bg-card-surface border border-dust rounded p-4 my-4 space-y-1 text-xs font-mono">
          <div>
            <span className="text-red-500 font-semibold">CRITICAL</span> - Miss distance {'<'} 1 km
          </div>
          <div>
            <span className="text-neon-orange font-semibold">HIGH</span> - Miss distance 1-5 km
          </div>
          <div>
            <span className="text-neon-yellow font-semibold">MODERATE</span> - Miss distance 5-25 km
          </div>
          <div>
            <span className="text-neon-green font-semibold">LOW</span> - Miss distance {'>'} 25 km
          </div>
        </div>
        <P>
          Set the screening threshold (maximum distance to consider) and click Run Screening. When
          events are found, toggle 3D Markers to visualize conjunction points in the scene as red
          spheres connecting the two satellites.
        </P>
        <P>
          Zenith supports two screening modes: <span className="text-neon-purple">Single Epoch</span>{' '}
          (checks positions at the current time) and{' '}
          <span className="text-neon-purple">Time Window</span> (propagates all satellites over a
          configurable duration and finds the closest approach for each pair). The time window mode
          uses WASM-accelerated batch screening and displays the Time of Closest Approach (TCA) for
          each event.
        </P>

        <H3 id="pass-predictor">Pass Predictor</H3>
        <P>
          Predicts when a satellite will pass over a ground station. The tool propagates the
          satellite's orbit over a configurable time window and computes visibility from the ground
          station location, accounting for the elevation mask angle.
        </P>
        <P>
          For each pass, the tool reports: start and end times (AOS/LOS), maximum elevation angle,
          pass duration, and minimum slant range. This is essential for scheduling communication
          windows and planning ground station operations.
        </P>
        <P>
          Configure the ground station latitude, longitude, altitude, and minimum elevation mask.
          Set the prediction window duration (up to 30 days) and click Predict Passes.
        </P>

        <H3 id="monte-carlo">Monte Carlo Propagation</H3>
        <P>
          Monte Carlo analysis quantifies uncertainty in orbit prediction by propagating many samples
          with randomized initial conditions. Starting from the satellite's current state, the tool:
        </P>
        <ol className="list-decimal list-inside text-sm font-mono text-space-300 mb-3 space-y-1">
          <li>
            Adds Gaussian noise to the initial position and velocity (user-specified standard
            deviations)
          </li>
          <li>Propagates each sample forward using the selected propagator</li>
          <li>
            Computes statistics: mean position/velocity and standard deviation along each axis
          </li>
        </ol>
        <P>
          The results show position and velocity uncertainty ellipsoids and a point cloud of all
          samples. Key parameters:
        </P>
        <div className="bg-card-surface border border-dust rounded p-4 my-4 space-y-1 text-xs font-mono">
          <div>
            <span className="text-neon-cyan">Samples</span> - Number of Monte Carlo runs (100-5000)
          </div>
          <div>
            <span className="text-neon-cyan">Pos sigma</span> - Position uncertainty standard
            deviation (km)
          </div>
          <div>
            <span className="text-neon-cyan">Vel sigma</span> - Velocity uncertainty standard
            deviation (km/s)
          </div>
          <div>
            <span className="text-neon-cyan">Duration</span> - Propagation time (days)
          </div>
          <div>
            <span className="text-neon-cyan">Seed</span> - Random seed for reproducibility
          </div>
        </div>
        <P>
          Toggle Cloud to show all propagated sample positions as points, and Ellipsoid to show the
          3D uncertainty ellipsoid. This is useful for understanding how initial state uncertainty
          grows over time and for collision probability estimation.
        </P>

        <H3 id="walker">Walker Delta Constellation</H3>
        <P>
          A Walker Delta constellation is a symmetric arrangement of satellites designed for global or
          regional coverage. It is specified by the notation{' '}
          <InlineMath tex="i:T/P/F" /> where:
        </P>
        <div className="bg-card-surface border border-dust rounded p-4 my-4 space-y-1 text-xs font-mono">
          <div>
            <span className="text-neon-cyan">i</span> - Inclination of all orbital planes (degrees)
          </div>
          <div>
            <span className="text-neon-cyan">T</span> - Total number of satellites
          </div>
          <div>
            <span className="text-neon-cyan">P</span> - Number of equally spaced orbital planes
          </div>
          <div>
            <span className="text-neon-cyan">F</span> - Phasing factor (relative spacing between
            planes)
          </div>
        </div>
        <P>
          The RAAN spacing between planes is uniform: <InlineMath tex="\Delta\Omega = 360°/P" />.
          The mean anomaly offset between adjacent planes is{' '}
          <InlineMath tex="\Delta M = F \times 360°/T" />. This ensures even coverage patterns. For
          example, a 24:6/1 constellation (like GPS) has 24 satellites in 6 planes with phasing
          factor 1.
        </P>
        <P>
          Enter the constellation parameters and click Generate Constellation to create the Walker
          pattern. The generated satellites are added to the 3D scene for visualization.
        </P>
        <Note>
          The altitude parameter sets the circular orbit altitude for all satellites. In practice,
          constellation design must also account for coverage requirements, inter-satellite link
          geometry, and launch vehicle constraints.
        </Note>
        </div>
      </div>
    </div>
  );
}
