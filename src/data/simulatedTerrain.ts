/**
 * EarthContours — Simulated Terrain Generator
 *
 * Generates a realistic-looking terrain elevation grid using:
 * 1. Multiple Gaussian "mountains" at real peak locations
 * 2. Layered sine waves for ridgelines and valleys
 * 3. Perlin-like noise for surface texture
 *
 * WHY simulate instead of using real data for MVP?
 * Real Copernicus GLO-10 data requires ~390MB per region.
 * For a web MVP we want fast startup, so we generate terrain procedurally
 * and use the real geographic data (peak names/locations) as anchors.
 *
 * The result looks like real Colorado/Alaska terrain without the download.
 * Session 2 replaces this with real elevation tiles.
 */

import type { Region, TerrainMeshData } from '../core/types'
import { createLogger } from '../core/logger'
import { TERRAIN_GRID_SIZE, TERRAIN_WORLD_KM } from '../core/constants'

const log = createLogger('DATA:TERRAIN')

type ProgressCallback = (progress: number) => void

// ─── Main Generator ───────────────────────────────────────────────────────────

/**
 * Generate a simulated terrain grid for the given region.
 *
 * @param region - The region metadata (center, bounds)
 * @param onProgress - Called with 0-1 progress as generation proceeds
 * @returns A TerrainMeshData with elevation array
 */
export async function generateSimulatedTerrain(
  region: Region,
  onProgress: ProgressCallback,
): Promise<TerrainMeshData> {
  const endTiming = log.time(`generateSimulatedTerrain(${region.id})`)

  const size = TERRAIN_GRID_SIZE
  const total = size * size
  const elevations = new Float32Array(total)

  // Region-specific terrain parameters
  const params = REGION_PARAMS[region.id] ?? REGION_PARAMS['colorado-rockies']

  log.debug('Terrain generation params', {
    region: region.id,
    gridSize: `${size}×${size}`,
    totalSamples: total.toLocaleString(),
    ...params,
  })

  onProgress(0.05)

  // ── Step 1: Add Gaussian mountain peaks ──────────────────────────────────
  // Each peak creates a hill with elevation falling off as a Gaussian curve.
  // This anchors the terrain to real geographic features.
  log.debug('Step 1: Adding Gaussian peaks...')

  for (let i = 0; i < size; i++) {
    for (let j = 0; j < size; j++) {
      const nx = j / (size - 1)  // 0-1 position across width
      const ny = i / (size - 1)  // 0-1 position across height

      let elevation = params.baseElevation

      // Add each peak as a Gaussian hill
      for (const peak of params.peaks) {
        const dx = nx - peak.nx
        const dy = ny - peak.ny
        const dist2 = dx * dx + dy * dy
        elevation += peak.height * Math.exp(-dist2 / (2 * peak.spread * peak.spread))
      }

      // Add ridge features using sine waves
      elevation += params.ridgeAmplitude * Math.sin(nx * params.ridgeFrequencyX * Math.PI)
      elevation += params.ridgeAmplitude * 0.5 * Math.sin(ny * params.ridgeFrequencyY * Math.PI)

      // Add valleys using cosine
      elevation += params.valleyDepth * Math.cos(nx * 3 * Math.PI) * Math.cos(ny * 2 * Math.PI) * 0.3

      elevations[i * size + j] = Math.max(params.seaLevel, elevation)
    }

    // Report progress every 16 rows
    if (i % 16 === 0) onProgress(0.05 + 0.7 * (i / size))
  }

  // ── Step 2: Add noise texture ──────────────────────────────────────────────
  log.debug('Step 2: Adding noise texture...')
  onProgress(0.75)

  for (let i = 0; i < total; i++) {
    // Simple value noise — pseudo-random perturbation
    elevations[i] += params.noiseAmplitude * pseudoNoise(i, total, params.noiseSeed)
  }

  onProgress(0.88)

  // ── Step 3: Smooth the terrain ─────────────────────────────────────────────
  log.debug('Step 3: Smoothing terrain...')
  const smoothed = gaussianSmooth(elevations, size, params.smoothPasses)
  onProgress(0.95)

  // ── Calculate statistics ───────────────────────────────────────────────────
  let minElev = Infinity
  let maxElev = -Infinity
  for (let i = 0; i < total; i++) {
    if (smoothed[i] < minElev) minElev = smoothed[i]
    if (smoothed[i] > maxElev) maxElev = smoothed[i]
  }

  onProgress(1.0)
  endTiming()

  log.info('Terrain generation complete', {
    minElevation: `${minElev.toFixed(0)}m`,
    maxElevation: `${maxElev.toFixed(0)}m`,
    range: `${(maxElev - minElev).toFixed(0)}m`,
  })

  return {
    width: size,
    height: size,
    elevations: smoothed,
    minElevation_m: minElev,
    maxElevation_m: maxElev,
    worldWidth_km: TERRAIN_WORLD_KM,
    worldDepth_km: TERRAIN_WORLD_KM,
    bounds: region.bounds,  // Required by TerrainMeshData type for ray-height-field renderer
  }
}

// ─── Noise & Smoothing ────────────────────────────────────────────────────────

/**
 * Simple deterministic pseudo-noise using sine hash.
 * Not true Perlin noise, but good enough for terrain texture.
 * The seed ensures different regions have different texture.
 */
function pseudoNoise(index: number, total: number, seed: number): number {
  const x = (index / total) * seed
  return (Math.sin(x * 12.9898 + seed * 78.233) * 43758.5453) % 1
}

/**
 * Simple box blur smoothing — averages each cell with its 4 neighbors.
 * Multiple passes approximate a Gaussian blur which softens hard edges.
 */
function gaussianSmooth(data: Float32Array, size: number, passes: number): Float32Array {
  let current = new Float32Array(data)
  const next = new Float32Array(data.length)

  for (let pass = 0; pass < passes; pass++) {
    for (let i = 0; i < size; i++) {
      for (let j = 0; j < size; j++) {
        const idx = i * size + j
        let sum = current[idx]
        let count = 1

        // Sample the 4 neighbors (clamp to edges)
        if (i > 0)        { sum += current[(i - 1) * size + j]; count++ }
        if (i < size - 1) { sum += current[(i + 1) * size + j]; count++ }
        if (j > 0)        { sum += current[i * size + (j - 1)]; count++ }
        if (j < size - 1) { sum += current[i * size + (j + 1)]; count++ }

        next[idx] = sum / count
      }
    }
    // Swap buffers
    current.set(next)
  }

  return current
}

// ─── Region-Specific Parameters ───────────────────────────────────────────────

interface TerrainParams {
  baseElevation: number      // m — base ground level across the region
  seaLevel: number           // m — minimum elevation (clamp floor)
  noiseAmplitude: number     // m — random perturbation magnitude
  noiseSeed: number          // Determines noise pattern (different per region)
  ridgeAmplitude: number     // m — ridge wave magnitude
  ridgeFrequencyX: number    // Cycles across width
  ridgeFrequencyY: number    // Cycles across height
  valleyDepth: number        // m — valley depression magnitude
  smoothPasses: number       // How many smoothing iterations
  peaks: Array<{
    nx: number               // 0-1 normalized X position
    ny: number               // 0-1 normalized Y position
    height: number           // Peak height above base (m)
    spread: number           // Gaussian spread (0=sharp, 1=wide)
  }>
}

const REGION_PARAMS: Record<string, TerrainParams> = {
  'colorado-rockies': {
    baseElevation: 2400,     // Colorado has very high base elevation (~8000ft)
    seaLevel: 1500,          // Even the lowlands are high
    noiseAmplitude: 120,
    noiseSeed: 42.7,
    ridgeAmplitude: 350,
    ridgeFrequencyX: 4,
    ridgeFrequencyY: 3,
    valleyDepth: 400,
    smoothPasses: 3,
    peaks: [
      // Mt. Elbert (highest) — center-west
      { nx: 0.28, ny: 0.55, height: 2000, spread: 0.08 },
      // Mt. Massive
      { nx: 0.25, ny: 0.48, height: 1990, spread: 0.07 },
      // Longs Peak — north
      { nx: 0.45, ny: 0.18, height: 1950, spread: 0.07 },
      // Pikes Peak — east
      { nx: 0.70, ny: 0.60, height: 1900, spread: 0.09 },
      // Maroon Bells — west
      { nx: 0.18, ny: 0.52, height: 1940, spread: 0.06 },
      // San Juan Range — south
      { nx: 0.35, ny: 0.80, height: 1750, spread: 0.10 },
      // Mosquito Range
      { nx: 0.42, ny: 0.45, height: 1600, spread: 0.09 },
      // Front Range background ridge
      { nx: 0.60, ny: 0.40, height: 1200, spread: 0.15 },
      // Sawatch Range background
      { nx: 0.30, ny: 0.40, height: 1400, spread: 0.18 },
    ],
  },

  'wa-cascades': {
    baseElevation: 400,
    seaLevel: 0,
    noiseAmplitude: 120,
    noiseSeed: 88.7,
    ridgeAmplitude: 800,
    ridgeFrequencyX: 4,
    ridgeFrequencyY: 3,
    valleyDepth: 350,
    smoothPasses: 3,
    peaks: [
      // Mount Rainier
      { nx: 0.45, ny: 0.55, height: 3990, spread: 0.10 },
      // Mount Baker
      { nx: 0.35, ny: 0.20, height: 3285, spread: 0.09 },
      // Glacier Peak
      { nx: 0.55, ny: 0.35, height: 3213, spread: 0.09 },
    ],
  },

  // 'alaska-range' is the current region id; 'anchorage-alaska' kept as alias
  'alaska-range': {
    baseElevation: 800,
    seaLevel: 0,
    noiseAmplitude: 180,
    noiseSeed: 137.3,
    ridgeAmplitude: 600,
    ridgeFrequencyX: 3,
    ridgeFrequencyY: 2,
    valleyDepth: 500,
    smoothPasses: 3,
    peaks: [
      { nx: 0.40, ny: 0.15, height: 5400, spread: 0.12 },
      { nx: 0.45, ny: 0.30, height: 3500, spread: 0.20 },
    ],
  },
  'anchorage-alaska': {
    baseElevation: 800,
    seaLevel: 0,             // Alaska goes to sea level in Cook Inlet
    noiseAmplitude: 180,
    noiseSeed: 137.3,
    ridgeAmplitude: 600,
    ridgeFrequencyX: 3,
    ridgeFrequencyY: 2,
    valleyDepth: 500,
    smoothPasses: 3,
    peaks: [
      // Denali — far north, massive
      { nx: 0.40, ny: 0.15, height: 5400, spread: 0.12 },
      // Mt. Foraker
      { nx: 0.35, ny: 0.18, height: 4500, spread: 0.09 },
      // Mt. Hunter
      { nx: 0.42, ny: 0.20, height: 3640, spread: 0.07 },
      // Mt. Spurr — west
      { nx: 0.25, ny: 0.48, height: 2570, spread: 0.08 },
      // Pioneer Peak — near Anchorage
      { nx: 0.62, ny: 0.65, height: 1770, spread: 0.06 },
      // Chugach Mountains
      { nx: 0.70, ny: 0.55, height: 2200, spread: 0.15 },
      // Alaska Range main ridge
      { nx: 0.45, ny: 0.30, height: 3500, spread: 0.20 },
    ],
  },
}
