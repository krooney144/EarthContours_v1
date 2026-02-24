/**
 * EarthContours — SCAN Multi-Resolution Tile Cache
 *
 * Provides elevation data at multiple zoom levels for the SCAN screen's
 * ray-height-field renderer. Zoom selection is based on ray distance:
 *
 *   dist < 5 km    → z13  (~19 m/px — fine foreground detail)
 *   5–20 km        → z11  (~76 m/px)
 *   20–80 km       → z10  (~152 m/px — region grid baseline)
 *   80–150 km      → z9   (~305 m/px)
 *   150–250 km     → z8   (~610 m/px — far panorama)
 *
 * Tiles are decoded from Terrarium RGB format to Float32Array on first load.
 * Failed fetches are silently ignored — the calling code falls back to the
 * lower-resolution region mesh grid.
 *
 * Used by: ScanScreen (main-thread real-time sampling while worker computes).
 */

import { loadElevationTile, decodeTerrarium } from './elevationLoader'
import { latLngToTile, tileToLatLng } from '../core/utils'
import { createLogger } from '../core/logger'

const log = createLogger('DATA:SCAN_TILE_CACHE')

const TILE_PX = 256

// ─── Distance → Zoom Level ────────────────────────────────────────────────────

/**
 * Pick the best Terrarium zoom level for a given ray distance.
 * Higher zoom = more detail but more tiles to fetch.
 * We match zoom to distance so nearby terrain gets high-res data
 * and distant terrain uses coarser (but wider-coverage) tiles.
 */
export function distanceToZoom(distM: number): number {
  if (distM < 5_000)   return 13
  if (distM < 20_000)  return 11
  if (distM < 80_000)  return 10
  if (distM < 150_000) return 9
  return 8
}

// ─── Cache Class ──────────────────────────────────────────────────────────────

export class ScanTileCache {
  /** Decoded elevation grids keyed by "z/x/y" */
  private elevGrids = new Map<string, Float32Array>()

  /** In-flight fetch promises — prevents duplicate concurrent requests */
  private pending = new Map<string, Promise<void>>()

  /** Total tiles successfully loaded since last clear */
  private loadedCount = 0

  // ── Tile Loading ─────────────────────────────────────────────────────────────

  /** Load one tile — safe to call concurrently for the same key. */
  private async loadTile(z: number, x: number, y: number): Promise<void> {
    const key = `${z}/${x}/${y}`
    if (this.elevGrids.has(key)) return
    if (this.pending.has(key)) {
      return this.pending.get(key)!
    }

    const promise = loadElevationTile(z, x, y)
      .then(tile => {
        this.elevGrids.set(key, decodeTerrarium(tile))
        this.loadedCount++
        log.debug('ScanTile cached', { key, total: this.loadedCount })
      })
      .catch(err => {
        // Non-fatal — ray will fall back to the lower-res region mesh
        log.debug('ScanTile load failed (will fallback to mesh)', { key, err: String(err) })
      })
      .finally(() => {
        this.pending.delete(key)
      })

    this.pending.set(key, promise)
    return promise
  }

  // ── Sampling ─────────────────────────────────────────────────────────────────

  /**
   * Bilinear-interpolated elevation at a lat/lng from the cached tile at `zoom`.
   * Returns null if the tile is not yet loaded — caller should fall back to mesh grid.
   */
  sampleBilinear(lat: number, lng: number, zoom: number): number | null {
    const { x: tx, y: ty } = latLngToTile(lat, lng, zoom)
    const key = `${zoom}/${tx}/${ty}`
    const grid = this.elevGrids.get(key)
    if (!grid) return null

    // Geographic bounds of this tile
    const tileNW = tileToLatLng(tx, ty, zoom)
    const tileSE = tileToLatLng(tx + 1, ty + 1, zoom)

    // Normalised position within tile [0, 1]
    const nx = (lng - tileNW.lng) / (tileSE.lng - tileNW.lng)
    const ny = (tileNW.lat - lat) / (tileNW.lat - tileSE.lat)

    // Map to pixel coords
    const sx = Math.max(0, Math.min(TILE_PX - 1, nx * (TILE_PX - 1)))
    const sy = Math.max(0, Math.min(TILE_PX - 1, ny * (TILE_PX - 1)))

    const x0 = Math.floor(sx), x1 = Math.min(x0 + 1, TILE_PX - 1)
    const y0 = Math.floor(sy), y1 = Math.min(y0 + 1, TILE_PX - 1)
    const fx = sx - x0, fy = sy - y0

    return (
      grid[y0 * TILE_PX + x0] * (1 - fx) * (1 - fy) +
      grid[y0 * TILE_PX + x1] * fx       * (1 - fy) +
      grid[y1 * TILE_PX + x0] * (1 - fx) * fy +
      grid[y1 * TILE_PX + x1] * fx       * fy
    )
  }

  // ── Prefetching ──────────────────────────────────────────────────────────────

  /**
   * Pre-fetch all tiles covering a circle around `center` at `zoom`.
   * Adds a 20% radius margin to avoid edge artifacts at the seam.
   */
  async prefetchArea(
    centerLat: number,
    centerLng: number,
    radiusM: number,
    zoom: number,
  ): Promise<void> {
    const cosLat = Math.cos(centerLat * Math.PI / 180)
    const dLat = (radiusM / 111_132) * 1.2
    const dLng = (radiusM / (111_320 * cosLat)) * 1.2

    const sw = latLngToTile(centerLat - dLat, centerLng - dLng, zoom)
    const ne = latLngToTile(centerLat + dLat, centerLng + dLng, zoom)

    const minX = Math.min(sw.x, ne.x), maxX = Math.max(sw.x, ne.x)
    const minY = Math.min(sw.y, ne.y), maxY = Math.max(sw.y, ne.y)
    const tilesW = maxX - minX + 1
    const tilesH = maxY - minY + 1

    log.info('Prefetching scan tiles', { zoom, radiusM, tiles: tilesW * tilesH })

    const batch: Promise<void>[] = []
    for (let x = minX; x <= maxX; x++) {
      for (let y = minY; y <= maxY; y++) {
        batch.push(this.loadTile(zoom, x, y))
      }
    }
    await Promise.all(batch)
  }

  /**
   * Pre-fetch all zoom levels needed for a full 250 km panorama from `viewerLat/Lng`.
   * Runs all zoom levels in parallel. Call this when the viewer's location changes.
   *
   * Tile count estimate:
   *   z13 (0–5 km):   ~4–9 tiles   — tiny download, critical for foreground ridgelines
   *   z11 (5–20 km):  ~4–9 tiles   — sharp mid-range terrain
   *   z8 (20–250 km): ~4–16 tiles  — wide-coverage far panorama
   */
  async prefetchForViewer(viewerLat: number, viewerLng: number): Promise<void> {
    log.info('Panorama tile prefetch starting', { viewerLat, viewerLng })
    await Promise.all([
      this.prefetchArea(viewerLat, viewerLng,   5_000, 13),
      this.prefetchArea(viewerLat, viewerLng,  20_000, 11),
      this.prefetchArea(viewerLat, viewerLng, 250_000,  8),
    ])
    log.info('Panorama tile prefetch complete', { cachedTiles: this.elevGrids.size })
  }

  /** Number of decoded tiles currently cached. */
  get cachedCount(): number { return this.elevGrids.size }

  /** Evict all tiles. Call when the viewer location changes by > 50 km. */
  clear(): void {
    this.elevGrids.clear()
    this.loadedCount = 0
    log.info('Scan tile cache cleared')
  }
}
