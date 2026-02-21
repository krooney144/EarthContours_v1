/**
 * EarthContours — Terrain Store
 *
 * Manages the terrain data — peaks, rivers, water bodies, and the elevation grid.
 * For MVP this uses simulated procedural data.
 * In Session 2 it will load real Copernicus GLO-10 elevation tiles.
 *
 * The terrain data is what drives all three screens:
 * - SCAN uses peaks[] to place labels in AR space
 * - EXPLORE uses meshData to draw the 3D contour lines
 * - MAP uses peaks[] to draw summit markers on the topo map
 */

import { create } from 'zustand'
import type { Peak, River, WaterBody, TerrainMeshData, LoadingState, Region } from '../core/types'
import { createLogger } from '../core/logger'
import { TerrainLoadError } from '../core/errors'
import { generateSimulatedTerrain } from '../data/simulatedTerrain'
import { COLORADO_PEAKS, ALASKA_PEAKS, COLORADO_RIVERS, ALASKA_RIVERS } from '../data/simulatedData'
import { REGIONS } from '../data/regions'

const log = createLogger('STORE:TERRAIN')

// ─── Store Interface ──────────────────────────────────────────────────────────

interface TerrainStore {
  activeRegion: Region | null
  peaks: Peak[]
  rivers: River[]
  waterBodies: WaterBody[]
  meshData: TerrainMeshData | null
  contourElevations: number[]    // The elevation values at which contour lines are drawn
  loadingState: LoadingState
  loadingProgress: number        // 0–100
  loadingMessage: string

  // Actions
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

  /**
   * Load terrain data for a named region.
   *
   * For MVP: generates simulated terrain data procedurally.
   * The progress updates make the loading UI feel real and informative.
   *
   * For Session 2: will fetch real MBTiles from bundled assets.
   */
  loadRegion: async (regionId) => {
    log.info('Loading terrain region', { regionId })

    // Check if this region is already loaded
    if (get().activeRegion?.id === regionId && get().loadingState === 'success') {
      log.debug('Region already loaded, skipping', { regionId })
      return
    }

    const region = REGIONS.find((r) => r.id === regionId)
    if (!region) {
      const err = new TerrainLoadError(regionId, 'Region not found in registry')
      log.error('Unknown region ID', { regionId, available: REGIONS.map((r) => r.id) })
      set({ loadingState: 'error', loadingMessage: err.message })
      return
    }

    // Start loading sequence
    set({
      loadingState: 'loading',
      loadingProgress: 0,
      loadingMessage: `Loading ${region.name}...`,
      activeRegion: region,
    })

    try {
      // ── Phase 1: Load peak data ──
      log.debug('Phase 1: Loading peak data...')
      set({ loadingProgress: 10, loadingMessage: 'Loading peak data...' })

      // Simulate async loading delay (will be real network requests in Session 2)
      await delay(200)

      const peaks = regionId === 'colorado-rockies' ? COLORADO_PEAKS : ALASKA_PEAKS
      log.info('Peaks loaded', { count: peaks.length, region: regionId })

      set({ peaks, loadingProgress: 30 })

      // ── Phase 2: Load river/water data ──
      log.debug('Phase 2: Loading river data...')
      set({ loadingMessage: 'Loading water features...' })
      await delay(150)

      const rivers = regionId === 'colorado-rockies' ? COLORADO_RIVERS : ALASKA_RIVERS
      log.info('Rivers loaded', { count: rivers.length })
      set({ rivers, waterBodies: [], loadingProgress: 50 })

      // ── Phase 3: Generate terrain mesh ──
      log.debug('Phase 3: Generating terrain mesh...')
      set({ loadingMessage: 'Generating terrain...' })
      await delay(300)

      const meshData = await generateSimulatedTerrain(region, (progress) => {
        set({ loadingProgress: 50 + Math.round(progress * 40) })
      })

      log.info('Terrain mesh generated', {
        width: meshData.width,
        height: meshData.height,
        minElev: `${meshData.minElevation_m.toFixed(0)}m`,
        maxElev: `${meshData.maxElevation_m.toFixed(0)}m`,
        worldSize: `${meshData.worldWidth_km}×${meshData.worldDepth_km}km`,
      })

      // ── Phase 4: Calculate contour elevations ──
      log.debug('Phase 4: Calculating contour line elevations...')
      set({ loadingProgress: 92, loadingMessage: 'Calculating contours...' })
      await delay(100)

      const contourElevations = calculateContourElevations(
        meshData.minElevation_m,
        meshData.maxElevation_m,
      )
      log.info('Contour elevations calculated', {
        count: contourElevations.length,
        range: `${contourElevations[0]?.toFixed(0)}m – ${contourElevations[contourElevations.length - 1]?.toFixed(0)}m`,
      })

      // ── Complete ──
      set({
        meshData,
        contourElevations,
        loadingState: 'success',
        loadingProgress: 100,
        loadingMessage: `${region.name} loaded`,
      })

      log.info('Region load COMPLETE', { regionId, peaks: peaks.length })

    } catch (err) {
      const loadError = new TerrainLoadError(regionId, err)
      log.error('Region load FAILED', { regionId, error: loadError })
      set({
        loadingState: 'error',
        loadingMessage: loadError.message,
        loadingProgress: 0,
      })
    }
  },

  setActiveRegion: (region) => {
    log.info('Active region set directly', { id: region.id, name: region.name })
    set({ activeRegion: region })
  },
}))

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Calculate the elevation values at which contour lines should be drawn.
 * Spacing varies by elevation range:
 * - <500m range: 50m intervals
 * - <2000m range: 100m intervals
 * - ≥2000m range: 200m intervals
 *
 * This matches how real topo maps choose contour intervals.
 */
function calculateContourElevations(minElev: number, maxElev: number): number[] {
  const range = maxElev - minElev
  const interval = range < 500 ? 50 : range < 2000 ? 100 : 200

  const contours: number[] = []
  // Start from the nearest interval above minElev
  const start = Math.ceil(minElev / interval) * interval
  for (let elev = start; elev <= maxElev; elev += interval) {
    contours.push(elev)
  }

  log.debug('Contour intervals calculated', { interval, count: contours.length, range })
  return contours
}

/** Small async delay — simulates async data loading */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
