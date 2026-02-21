/**
 * EarthContours — TerrainProvider Interface
 *
 * A thin contract that decouples the SCAN/EXPLORE renderers from
 * any specific elevation data source. Swap Terrarium → Copernicus →
 * Cesium by implementing this interface, touching zero renderer code.
 *
 * Current implementation: TerrariumTerrainProvider
 *   wraps the existing elevationLoader.ts pipeline.
 *
 * Future implementations:
 *   CopernicusTerrainProvider  — Copernicus GLO-10 tiles
 *   MapTilerTerrainProvider    — MapTiler Terrain-RGB-v2
 *   CesiumTerrainProvider      — Cesium quantized mesh (Session 3+)
 */

import { createLogger } from '../core/logger'
import { loadElevationTile, decodeTerrarium } from './elevationLoader'
import type { Region } from '../core/types'
import { latLngToTile } from '../core/utils'

const log = createLogger('DATA:TERRAIN_PROVIDER')

// ─── Interface ────────────────────────────────────────────────────────────────

/**
 * Bounding box in geographic coordinates.
 */
export interface Bounds {
  north: number
  south: number
  east: number
  west: number
}

/**
 * A single terrain tile's elevation data.
 * Row-major, left-to-right, top-to-bottom.
 */
export interface HeightGrid {
  heights: Float32Array
  width: number   // columns
  height: number  // rows
  /** Elevation range for quick normalization */
  minElev: number
  maxElev: number
}

/**
 * Core contract that all terrain backends must fulfill.
 *
 * Renderers (SCAN, EXPLORE) only call these methods — they never touch
 * AWS URLs, IndexedDB, or tile formats directly.
 */
export interface TerrainProvider {
  /**
   * Synchronously sample the elevation (meters) at a lat/lon.
   * Implementations may use a pre-loaded mesh for fast real-time sampling.
   * Returns 0 if the location is outside the loaded region.
   */
  sampleHeight(lat: number, lon: number): number

  /**
   * Fetch elevation heights for a map tile (z/x/y) as a Float32Array grid.
   * The tile is in the standard web Mercator tile coordinate system.
   * Returns null if the tile could not be loaded.
   */
  getTileHeights(z: number, x: number, y: number): Promise<HeightGrid | null>

  /**
   * Returns the recommended contour step size (meters) for a given distance
   * from the viewer. Closer → finer contours; farther → coarser.
   *
   * Implementations can ignore this and always return a constant step.
   * Used by the renderer to decide which contour levels to draw at each
   * distance band — avoids over-rendering tiny contours far away.
   */
  getContourStepAt(distanceMeters: number): number

  /**
   * Warm up the tile cache for a region across a range of zoom levels.
   * Fire-and-forget — errors are silently swallowed.
   */
  prefetchTiles(bounds: Bounds, zoomRange: [number, number]): Promise<void>
}

// ─── TerrariumTerrainProvider ─────────────────────────────────────────────────

/**
 * Terrain backend backed by AWS Terrarium RGB tiles (free, global, no key).
 *
 * For real-time sampling it requires a pre-loaded elevation grid for the
 * active region — call `loadGrid(region, grid)` before using `sampleHeight`.
 *
 * Tile fetching goes through the existing elevationLoader.ts pipeline, which
 * already handles the IndexedDB → local offline → AWS fallback chain.
 */
export class TerrariumTerrainProvider implements TerrainProvider {
  private grid: Float32Array | null = null
  private gridW = 0
  private gridH = 0
  private gridBounds: Bounds = { north: 0, south: 0, east: 0, west: 0 }

  /**
   * Load a pre-decoded elevation grid for fast synchronous `sampleHeight` calls.
   * Call this whenever terrainStore.meshData changes.
   */
  loadGrid(elevations: Float32Array, width: number, height: number, bounds: Bounds): void {
    this.grid = elevations
    this.gridW = width
    this.gridH = height
    this.gridBounds = bounds
    log.debug('Grid loaded', { width, height, bounds })
  }

  sampleHeight(lat: number, lon: number): number {
    if (!this.grid) return 0
    const { north, south, east, west } = this.gridBounds

    // Normalize to [0,1] within bounds
    const nx = (lon - west) / (east - west)
    const ny = (north - lat) / (north - south)

    if (nx < 0 || nx > 1 || ny < 0 || ny > 1) return 0

    // Bilinear interpolation
    const sx = nx * (this.gridW - 1)
    const sy = ny * (this.gridH - 1)
    const x0 = Math.floor(sx), x1 = Math.min(x0 + 1, this.gridW - 1)
    const y0 = Math.floor(sy), y1 = Math.min(y0 + 1, this.gridH - 1)
    const fx = sx - x0, fy = sy - y0

    return (
      (this.grid[y0 * this.gridW + x0] ?? 0) * (1 - fx) * (1 - fy) +
      (this.grid[y0 * this.gridW + x1] ?? 0) * fx       * (1 - fy) +
      (this.grid[y1 * this.gridW + x0] ?? 0) * (1 - fx) * fy +
      (this.grid[y1 * this.gridW + x1] ?? 0) * fx       * fy
    )
  }

  async getTileHeights(z: number, x: number, y: number): Promise<HeightGrid | null> {
    try {
      const cachedTile = await loadElevationTile(z, x, y)
      const heights = decodeTerrarium(cachedTile)

      let minElev = Infinity, maxElev = -Infinity
      for (let i = 0; i < heights.length; i++) {
        if (heights[i] < minElev) minElev = heights[i]
        if (heights[i] > maxElev) maxElev = heights[i]
      }

      return {
        heights,
        width: cachedTile.width,
        height: cachedTile.height,
        minElev,
        maxElev,
      }
    } catch (err) {
      log.warn('getTileHeights failed', { z, x, y, err })
      return null
    }
  }

  getContourStepAt(distanceMeters: number): number {
    // Closer than 5km → 100m contours; 5–20km → 200m; beyond → 500m
    if (distanceMeters < 5_000)  return 100
    if (distanceMeters < 20_000) return 200
    return 500
  }

  async prefetchTiles(bounds: Bounds, zoomRange: [number, number]): Promise<void> {
    const [zMin, zMax] = zoomRange
    const promises: Promise<void>[] = []

    for (let z = zMin; z <= zMax; z++) {
      const nw = latLngToTile(bounds.north, bounds.west, z)
      const se = latLngToTile(bounds.south, bounds.east, z)

      for (let x = nw.x; x <= se.x; x++) {
        for (let y = nw.y; y <= se.y; y++) {
          promises.push(
            loadElevationTile(z, x, y)
              .then(() => { /* warm cache */ })
              .catch(() => { /* ignore */ }),
          )
        }
      }
    }

    await Promise.all(promises)
    log.info('Prefetch complete', { bounds, zoomRange, tiles: promises.length })
  }
}

// ─── Singleton Instance ───────────────────────────────────────────────────────

/**
 * Singleton TerrainProvider used by SCAN and MAP renderers.
 * Swap the class to change the entire elevation backend.
 */
export const terrainProvider = new TerrariumTerrainProvider()

// Helper: hydrate the provider when the terrain store updates
export function updateTerrainProviderGrid(
  elevations: Float32Array,
  width: number,
  height: number,
  region: Region,
): void {
  terrainProvider.loadGrid(elevations, width, height, region.bounds)
  log.info('TerrainProvider grid updated', {
    region: region.id,
    size: `${width}×${height}`,
  })
}
