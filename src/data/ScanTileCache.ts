/**
 * EarthContours — SCAN Multi-Resolution Tile Cache
 *
 * Provides elevation data at multiple zoom levels for the SCAN screen's
 * ray-height-field renderer. Zoom selection is based on ray distance:
 *
 *   dist < 1 km    → z15  (~4.8 m/px — ultra-near 50ft contour detail)
 *   1–4.5 km       → z14  (~9.5 m/px — ultra-near outer)
 *   4.5–10.5 km    → z13  (~19 m/px — near foreground detail)
 *   10.5–31 km     → z11  (~76 m/px — mid-near)
 *   31–81 km       → z10  (~152 m/px — mid)
 *   81–152 km      → z9   (~305 m/px — mid-far)
 *   152–400 km     → z8   (~610 m/px — far panorama)
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
 *
 * z15 (~4.8 m/px) for ultra-near 0–1 km: 50ft contour precision
 * z14 (~9.5 m/px) for ultra-near 1–4.5 km
 * z13 (~19 m/px) for near 4.5–10.5 km
 */
export function distanceToZoom(distM: number): number {
  if (distM < 1_000)   return 15
  if (distM < 4_500)   return 14
  if (distM < 10_500)  return 13
  if (distM < 31_000)  return 11
  if (distM < 81_000)  return 10
  if (distM < 152_000) return 9
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
   * Pre-fetch all zoom levels needed for a full 400 km panorama from `viewerLat/Lng`.
   * Runs all zoom levels in parallel. Call this when the viewer's location changes.
   *
   * Tile count estimate:
   *   z15 (0–1 km):    ~4–9 tiles   — ultra-near detail for 50ft contours
   *   z14 (1–4.5 km):  ~12–20 tiles — ultra-near outer
   *   z13 (4.5–10 km): ~4–9 tiles   — near foreground ridgelines
   *   z11 (10–31 km):  ~4–9 tiles   — mid-near terrain
   *   z8 (31–400 km):  ~4–16 tiles  — wide-coverage far panorama
   */
  async prefetchForViewer(viewerLat: number, viewerLng: number): Promise<void> {
    log.info('Panorama tile prefetch starting', { viewerLat, viewerLng })
    await Promise.all([
      this.prefetchArea(viewerLat, viewerLng,   1_000, 15),
      this.prefetchArea(viewerLat, viewerLng,   4_500, 14),
      this.prefetchArea(viewerLat, viewerLng,  10_500, 13),
      this.prefetchArea(viewerLat, viewerLng,  31_000, 11),
      this.prefetchArea(viewerLat, viewerLng, 400_000,  8),
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
