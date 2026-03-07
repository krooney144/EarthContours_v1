/**
 * EarthContours — Terrain Store
 *
 * Manages elevation data, peaks, rivers, and the terrain grid.
 *
 * Elevation source priority (handled by ElevationLoader):
 *   1. IndexedDB (cached from prior session — instant)
 *   2. Local /tiles/elevation/ files (offline bundle)
 *   3. AWS Terrarium tiles (live network)
 *   4. Simulated procedural terrain (fallback if all network fails)
 *
 * The four fallback levels mean the app works:
 *   - On fast WiFi (AWS tiles)
 *   - Offline with pre-bundled tiles (local files)
 *   - Offline with prior cached data (IndexedDB)
 *   - With no data at all (simulated — always works)
 */

import { create } from 'zustand'
import type { Peak, River, WaterBody, TerrainMeshData, LoadingState, Region } from '../core/types'
import { createLogger } from '../core/logger'
import { TerrainLoadError } from '../core/errors'
import { loadRegionElevation } from '../data/elevationLoader'
import { generateSimulatedTerrain } from '../data/simulatedTerrain'
import { COLORADO_PEAKS, ALASKA_PEAKS, COLORADO_RIVERS, ALASKA_RIVERS } from '../data/simulatedData'
import { REGIONS } from '../data/regions'
import { TERRAIN_GRID_SIZE, ENU_M_PER_DEG_LAT, ENU_M_PER_DEG_LON_AT_LAT } from '../core/constants'

const log = createLogger('STORE:TERRAIN')

// ─── Store Interface ──────────────────────────────────────────────────────────

interface TerrainStore {
  activeRegion: Region | null
  peaks: Peak[]
  rivers: River[]
  waterBodies: WaterBody[]
  meshData: TerrainMeshData | null
  contourElevations: number[]
  loadingState: LoadingState
  loadingProgress: number
  loadingMessage: string
  /** Whether the current elevation data is real (AWS/local) vs simulated */
  isRealElevation: boolean

  loadRegion: (regionId: string) => Promise<void>
  setActiveRegion: (region: Region) => void
}

// ─── Store Implementation ─────────────────────────────────────────────────────

export const useTerrainStore = create<TerrainStore>()((set, get) => ({
  activeRegion: null,
  peaks: [],
  rivers: [],
  waterBodies: [],
  meshData: null,
  contourElevations: [],
  loadingState: 'idle',
  loadingProgress: 0,
  loadingMessage: '',
  isRealElevation: false,

  loadRegion: async (regionId) => {
    log.info('Loading terrain region', { regionId })

    if (get().activeRegion?.id === regionId && get().loadingState === 'success') {
      log.debug('Region already loaded, skipping', { regionId })
      return
    }

    const region = REGIONS.find((r) => r.id === regionId)
    if (!region) {
      const err = new TerrainLoadError(regionId, 'Region not found in registry')
      log.error('Unknown region ID', { regionId })
      set({ loadingState: 'error', loadingMessage: err.message })
      return
    }

    set({ loadingState: 'loading', loadingProgress: 0, loadingMessage: `Loading ${region.name}...`, activeRegion: region })

    try {
      // ── Phase 1: Peak & river data ─────────────────────────────────────────
      set({ loadingProgress: 5, loadingMessage: 'Loading peak data...' })
      const peaks =
        regionId === 'colorado-rockies' ? COLORADO_PEAKS :
        ALASKA_PEAKS
      const rivers = regionId === 'colorado-rockies' ? COLORADO_RIVERS : ALASKA_RIVERS
      log.info('Peak/river data loaded', { peaks: peaks.length, rivers: rivers.length })
      set({ peaks, rivers, waterBodies: [], loadingProgress: 15 })

      // ── Phase 2: Real elevation data (AWS Terrarium with fallback) ─────────
      let elevations: Float32Array | null = null
      let isRealElevation = false

      set({ loadingMessage: 'Fetching elevation tiles...' })
      log.info('Attempting real elevation load (AWS Terrarium tiles)', { region: region.id })

      try {
        elevations = await loadRegionElevation(
          region,
          TERRAIN_GRID_SIZE,
          (p) => set({ loadingProgress: 15 + Math.round(p * 65) }),
        )
        isRealElevation = true
        log.info('━━━ TERRAIN SOURCE: REAL (AWS Terrarium DEM tiles) ━━━', { region: region.id })
      } catch (elevErr) {
        log.warn('━━━ TERRAIN SOURCE: SIMULATED (real data unavailable) ━━━', { region: region.id, reason: elevErr })
        set({ loadingMessage: 'Network unavailable — using simulated terrain...' })

        // Simulated terrain fallback — always works, no network needed
        const simData = await generateSimulatedTerrain(region, (p) => {
          set({ loadingProgress: 15 + Math.round(p * 65) })
        })
        elevations = simData.elevations
        isRealElevation = false
      }

      // ── Phase 3: Assemble TerrainMeshData ──────────────────────────────────
      set({ loadingProgress: 82, loadingMessage: 'Processing elevation grid...' })

      let minElev = Infinity, maxElev = -Infinity
      for (let i = 0; i < elevations.length; i++) {
        if (elevations[i] < minElev) minElev = elevations[i]
        if (elevations[i] > maxElev) maxElev = elevations[i]
      }

      log.info('Elevation grid stats', {
        min: `${minElev.toFixed(0)}m`,
        max: `${maxElev.toFixed(0)}m`,
        range: `${(maxElev - minElev).toFixed(0)}m`,
        isReal: isRealElevation,
      })

      // Compute real physical dimensions from the region's lat/lng bounds
      // using the ENU flat-earth approximation (< 0.2 % error for ≤ 300 km chunks).
      const lat0 = (region.bounds.north + region.bounds.south) / 2
      const worldWidth_km  = (region.bounds.east  - region.bounds.west)  * ENU_M_PER_DEG_LON_AT_LAT(lat0) / 1000
      const worldDepth_km  = (region.bounds.north - region.bounds.south) * ENU_M_PER_DEG_LAT / 1000

      log.info('Terrain physical dimensions', {
        worldWidth_km:  worldWidth_km.toFixed(1),
        worldDepth_km:  worldDepth_km.toFixed(1),
        lat0: lat0.toFixed(3),
      })

      const meshData: TerrainMeshData = {
        width: TERRAIN_GRID_SIZE,
        height: TERRAIN_GRID_SIZE,
        elevations,
        minElevation_m: minElev,
        maxElevation_m: maxElev,
        worldWidth_km,
        worldDepth_km,
        bounds: region.bounds,
      }

      // ── Phase 4: Contour elevations ────────────────────────────────────────
      set({ loadingProgress: 90, loadingMessage: 'Calculating contours...' })
      const contourElevations = calculateContourElevations(minElev, maxElev)
      log.info('Contours calculated', { count: contourElevations.length, interval: contourElevations[1] ? (contourElevations[1] - contourElevations[0]).toFixed(0) + 'm' : 'N/A' })

      set({
        meshData,
        contourElevations,
        isRealElevation,
        loadingState: 'success',
        loadingProgress: 100,
        loadingMessage: isRealElevation
          ? `${region.name} — real elevation data`
          : `${region.name} — simulated terrain`,
      })

      log.info('Region load COMPLETE', { regionId, isRealElevation, peaks: peaks.length })

    } catch (err) {
      const loadError = new TerrainLoadError(regionId, err)
      log.error('Region load FAILED', { regionId, error: loadError })
      set({ loadingState: 'error', loadingMessage: loadError.message, loadingProgress: 0 })
    }
  },

  setActiveRegion: (region) => {
    log.info('Active region set', { id: region.id })
    set({ activeRegion: region })
  },
}))

// ─── Helpers ──────────────────────────────────────────────────────────────────

function calculateContourElevations(minElev: number, maxElev: number): number[] {
  const range = maxElev - minElev

  // Interval selection matches standard USGS topographic map conventions:
  //   flat / coastal terrain  → 50m  (~164ft) — enough detail, not cluttered
  //   rolling hills           → 100m (~328ft)
  //   mountain terrain        → 100m — 2× denser than previous 200m default
  //     (256×256 grid ≈ 156m/sample over 40km, so 100m intervals are resolvable)
  const interval = range < 500 ? 50 : 100

  const contours: number[] = []
  const start = Math.ceil(minElev / interval) * interval
  for (let elev = start; elev <= maxElev; elev += interval) {
    contours.push(elev)
  }
  log.debug('Contour elevations', { interval, count: contours.length, range: range.toFixed(0) })
  return contours
}
