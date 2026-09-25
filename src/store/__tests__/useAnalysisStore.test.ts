import { describe, it, expect, vi, beforeEach } from 'vitest'
import { useAnalysisStore } from '../useAnalysisStore'

// Mock wasmLoader (used by computeGroundTrack for sgp4Propagate)
vi.mock('@/orbit/wasmLoader', () => ({
    sgp4Propagate: vi.fn(() => ({ x: 6781, y: 0, z: 0, vx: 0, vy: 7.669, vz: 0 })),
    sgp4Init: vi.fn(() => 1),
    sgp4GetElements: vi.fn(() => ({ a: 6781, e: 0.0007, i: 0.9, raan: 3.49, argp: 0.87, ta: 5.41 })),
    sgp4Destroy: vi.fn(),
    sgp4Clear: vi.fn(),
}))

// Mock analysisLoader (used by computeManeuver and computeGroundTrack via dynamic import)
vi.mock('@/orbit/analysisLoader', () => ({
    hohmannFromAltitudes: vi.fn(() => ({
        dv1: 3.5,
        dv2: 1.5,
        dvTotal: 5.0,
        transferTimeS: 180000,
        aTransfer: 24000,
    })),
    computeGroundTrack: vi.fn(() => [
        { lat: 0.5, lon: 1.2, alt: 400, jd: 2451545.0 },
        { lat: 0.6, lon: 1.3, alt: 405, jd: 2451545.1 },
    ]),
}))

// Reset store between tests
beforeEach(() => {
    useAnalysisStore.setState({
        maneuverAlt1Km: 400,
        maneuverAlt2Km: 35786,
        maneuverResult: null,
        showGroundTrack: false,
        groundTrackDays: 1,
        groundTrackPoints: [],
        conjunctionEvents: [],
        conjunctionDistanceKm: 10,
        showConjunctionMarkers: true,
        mcResult: null,
        showMcCloud: false,
        showMcEllipsoid: false,
        walkerConfig: {
            inclinationDeg: 51.6,
            totalSats: 24,
            numPlanes: 6,
            phasingFactor: 1,
            altitudeKm: 20200,
        },
    })
})

// =============================================================================
// setManeuverAlt1 / setManeuverAlt2
// =============================================================================

describe('setManeuverAlt1', () => {
    it('updates maneuverAlt1Km', () => {
        useAnalysisStore.getState().setManeuverAlt1(500)
        expect(useAnalysisStore.getState().maneuverAlt1Km).toBe(500)
    })

    it('accepts zero', () => {
        useAnalysisStore.getState().setManeuverAlt1(0)
        expect(useAnalysisStore.getState().maneuverAlt1Km).toBe(0)
    })

    it('accepts large values', () => {
        useAnalysisStore.getState().setManeuverAlt1(100000)
        expect(useAnalysisStore.getState().maneuverAlt1Km).toBe(100000)
    })
})

describe('setManeuverAlt2', () => {
    it('updates maneuverAlt2Km', () => {
        useAnalysisStore.getState().setManeuverAlt2(500)
        expect(useAnalysisStore.getState().maneuverAlt2Km).toBe(500)
    })

    it('accepts zero', () => {
        useAnalysisStore.getState().setManeuverAlt2(0)
        expect(useAnalysisStore.getState().maneuverAlt2Km).toBe(0)
    })

    it('accepts negative (deorbit)', () => {
        useAnalysisStore.getState().setManeuverAlt2(-50)
        expect(useAnalysisStore.getState().maneuverAlt2Km).toBe(-50)
    })
})

// =============================================================================
// computeManeuver
// =============================================================================

describe('computeManeuver', () => {
    it('calls hohmannFromAltitudes and stores result', async () => {
        const { hohmannFromAltitudes } = await import('@/orbit/analysisLoader')
        vi.mocked(hohmannFromAltitudes).mockClear()

        useAnalysisStore.getState().setManeuverAlt1(400)
        useAnalysisStore.getState().setManeuverAlt2(35786)
        useAnalysisStore.getState().computeManeuver()

        // Dynamic import is async, wait for the microtask
        await new Promise((r) => setTimeout(r, 10))

        expect(hohmannFromAltitudes).toHaveBeenCalledWith(400, 35786)
        expect(useAnalysisStore.getState().maneuverResult).not.toBeNull()
        expect(useAnalysisStore.getState().maneuverResult!.dvTotal).toBe(5.0)
    })

    it('uses current altitude values from store', async () => {
        const { hohmannFromAltitudes } = await import('@/orbit/analysisLoader')
        vi.mocked(hohmannFromAltitudes).mockClear()

        useAnalysisStore.getState().setManeuverAlt1(600)
        useAnalysisStore.getState().setManeuverAlt2(20200)
        useAnalysisStore.getState().computeManeuver()

        await new Promise((r) => setTimeout(r, 10))

        expect(hohmannFromAltitudes).toHaveBeenCalledWith(600, 20200)
    })
})

// =============================================================================
// toggleGroundTrack
// =============================================================================

describe('toggleGroundTrack', () => {
    it('toggles showGroundTrack from false to true', () => {
        expect(useAnalysisStore.getState().showGroundTrack).toBe(false)
        useAnalysisStore.getState().toggleGroundTrack()
        expect(useAnalysisStore.getState().showGroundTrack).toBe(true)
    })

    it('toggles showGroundTrack from true to false', () => {
        useAnalysisStore.getState().toggleGroundTrack()
        expect(useAnalysisStore.getState().showGroundTrack).toBe(true)
        useAnalysisStore.getState().toggleGroundTrack()
        expect(useAnalysisStore.getState().showGroundTrack).toBe(false)
    })
})

// =============================================================================
// setGroundTrackDays
// =============================================================================

describe('setGroundTrackDays', () => {
    it('updates groundTrackDays', () => {
        useAnalysisStore.getState().setGroundTrackDays(5)
        expect(useAnalysisStore.getState().groundTrackDays).toBe(5)
    })

    it('accepts fractional values', () => {
        useAnalysisStore.getState().setGroundTrackDays(0.5)
        expect(useAnalysisStore.getState().groundTrackDays).toBe(0.5)
    })

    it('accepts zero', () => {
        useAnalysisStore.getState().setGroundTrackDays(0)
        expect(useAnalysisStore.getState().groundTrackDays).toBe(0)
    })
})

// =============================================================================
// setConjunctionEvents
// =============================================================================

describe('setConjunctionEvents', () => {
    it('stores events array', () => {
        const events = [
            {
                sat1Name: 'ISS',
                sat2Name: 'COSMOS',
                sat1Id: 'sat-1',
                sat2Id: 'sat-2',
                missDistanceKm: 5.2,
                riskLevel: 'CRITICAL' as const,
                position1: { x: 6781, y: 0, z: 0 },
                position2: { x: 6782, y: 1, z: 0 },
            },
        ]
        useAnalysisStore.getState().setConjunctionEvents(events)
        expect(useAnalysisStore.getState().conjunctionEvents).toEqual(events)
        expect(useAnalysisStore.getState().conjunctionEvents).toHaveLength(1)
    })

    it('clears events with empty array', () => {
        useAnalysisStore.getState().setConjunctionEvents([
            {
                sat1Name: 'ISS',
                sat2Name: 'COSMOS',
                sat1Id: 'sat-1',
                sat2Id: 'sat-2',
                missDistanceKm: 5.2,
                riskLevel: 'HIGH' as const,
                position1: { x: 6781, y: 0, z: 0 },
                position2: { x: 6782, y: 1, z: 0 },
            },
        ])
        expect(useAnalysisStore.getState().conjunctionEvents).toHaveLength(1)
        useAnalysisStore.getState().setConjunctionEvents([])
        expect(useAnalysisStore.getState().conjunctionEvents).toHaveLength(0)
    })
})

// =============================================================================
// toggleConjunctionMarkers
// =============================================================================

describe('toggleConjunctionMarkers', () => {
    it('toggles from true to false', () => {
        expect(useAnalysisStore.getState().showConjunctionMarkers).toBe(true)
        useAnalysisStore.getState().toggleConjunctionMarkers()
        expect(useAnalysisStore.getState().showConjunctionMarkers).toBe(false)
    })

    it('toggles from false to true', () => {
        useAnalysisStore.getState().toggleConjunctionMarkers()
        useAnalysisStore.getState().toggleConjunctionMarkers()
        expect(useAnalysisStore.getState().showConjunctionMarkers).toBe(true)
    })
})

// =============================================================================
// toggleMcCloud / toggleMcEllipsoid
// =============================================================================

describe('toggleMcCloud', () => {
    it('toggles from false to true', () => {
        expect(useAnalysisStore.getState().showMcCloud).toBe(false)
        useAnalysisStore.getState().toggleMcCloud()
        expect(useAnalysisStore.getState().showMcCloud).toBe(true)
    })

    it('toggles from true to false', () => {
        useAnalysisStore.getState().toggleMcCloud()
        useAnalysisStore.getState().toggleMcCloud()
        expect(useAnalysisStore.getState().showMcCloud).toBe(false)
    })
})

describe('toggleMcEllipsoid', () => {
    it('toggles from false to true', () => {
        expect(useAnalysisStore.getState().showMcEllipsoid).toBe(false)
        useAnalysisStore.getState().toggleMcEllipsoid()
        expect(useAnalysisStore.getState().showMcEllipsoid).toBe(true)
    })

    it('toggles from true to false', () => {
        useAnalysisStore.getState().toggleMcEllipsoid()
        useAnalysisStore.getState().toggleMcEllipsoid()
        expect(useAnalysisStore.getState().showMcEllipsoid).toBe(false)
    })
})

// =============================================================================
// setWalkerConfig
// =============================================================================

describe('setWalkerConfig', () => {
    it('merges partial config with existing', () => {
        useAnalysisStore.getState().setWalkerConfig({ totalSats: 48 })
        const config = useAnalysisStore.getState().walkerConfig
        expect(config.totalSats).toBe(48)
        // Other fields preserved
        expect(config.inclinationDeg).toBe(51.6)
        expect(config.numPlanes).toBe(6)
        expect(config.phasingFactor).toBe(1)
        expect(config.altitudeKm).toBe(20200)
    })

    it('merges multiple fields', () => {
        useAnalysisStore.getState().setWalkerConfig({
            totalSats: 72,
            numPlanes: 12,
            altitudeKm: 550,
        })
        const config = useAnalysisStore.getState().walkerConfig
        expect(config.totalSats).toBe(72)
        expect(config.numPlanes).toBe(12)
        expect(config.altitudeKm).toBe(550)
        expect(config.inclinationDeg).toBe(51.6)
    })

    it('overwrites a field completely', () => {
        useAnalysisStore.getState().setWalkerConfig({ altitudeKm: 400 })
        expect(useAnalysisStore.getState().walkerConfig.altitudeKm).toBe(400)
        useAnalysisStore.getState().setWalkerConfig({ altitudeKm: 1200 })
        expect(useAnalysisStore.getState().walkerConfig.altitudeKm).toBe(1200)
    })
})

// =============================================================================
// setConjunctionDistance
// =============================================================================

describe('setConjunctionDistance', () => {
    it('updates conjunctionDistanceKm', () => {
        useAnalysisStore.getState().setConjunctionDistance(50)
        expect(useAnalysisStore.getState().conjunctionDistanceKm).toBe(50)
    })

    it('accepts zero', () => {
        useAnalysisStore.getState().setConjunctionDistance(0)
        expect(useAnalysisStore.getState().conjunctionDistanceKm).toBe(0)
    })
})

// =============================================================================
// Default values
// =============================================================================

describe('Default values', () => {
    it('maneuverAlt1Km defaults to 400', () => {
        expect(useAnalysisStore.getState().maneuverAlt1Km).toBe(400)
    })

    it('maneuverAlt2Km defaults to 35786', () => {
        expect(useAnalysisStore.getState().maneuverAlt2Km).toBe(35786)
    })

    it('groundTrackDays defaults to 1', () => {
        expect(useAnalysisStore.getState().groundTrackDays).toBe(1)
    })

    it('conjunctionDistanceKm defaults to 10', () => {
        expect(useAnalysisStore.getState().conjunctionDistanceKm).toBe(10)
    })

    it('walkerConfig has correct defaults', () => {
        const config = useAnalysisStore.getState().walkerConfig
        expect(config.inclinationDeg).toBe(51.6)
        expect(config.totalSats).toBe(24)
        expect(config.numPlanes).toBe(6)
        expect(config.phasingFactor).toBe(1)
        expect(config.altitudeKm).toBe(20200)
    })
})
