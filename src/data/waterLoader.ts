/**
 * EarthContours — Tiled Water Feature Loader (Phase 2)
 *
 * Orchestrates water feature loading via a Web Worker.
 * The main thread computes which tiles are visible, the worker
 * handles Overpass fetching, JSON parsing, stitching, and caching.
 *
 * ── Tile Grid ────────────────────────────────────────────────────────────
 *
 *   The world is divided into a fixed 1° × 1° grid.
 *   Each tile is an independent Overpass query + IndexedDB cache entry.
 *   Panning reuses cached tiles — only new tiles trigger network requests.
 *
 * ── Public API ───────────────────────────────────────────────────────────
 *
 *   WaterTileManager — singleton class that manages the worker lifecycle
 *   and exposes a simple `requestTiles(south, west, north, east)` method.
 *
 *   fetchWaterNear(lat, lng, radiusKm) — convenience wrapper for SCAN/EXPLORE.
 */

import { createLogger } from '../core/logger'
import type { WaterBody, River } from '../core/types'

const log = createLogger('DATA:WATER_LOADER')

// ─── Tile Grid Constants ────────────────────────────────────────────────────

const TILE_STEP_DEG = 1.0  // Each tile covers 1° × 1°

// ─── Result Types ───────────────────────────────────────────────────────────

export interface WaterNearResult {
  lakes:  WaterBody[]
  rivers: River[]
}

export interface WaterTileStats {
  totalTiles: number
  cached: number
  fetched: number
  totalFetchMs: number
  totalLakes: number
  totalRivers: number
  pendingTiles: number
  generation: number
}

// ─── Tile Key Computation ───────────────────────────────────────────────────

interface TileRequest {
  key: string
  south: number
  west: number
  north: number
  east: number
}

/** Compute all 1° tiles that overlap a bounding box */
function computeTiles(south: number, west: number, north: number, east: number): TileRequest[] {
  const tiles: TileRequest[] = []
  const s0 = Math.floor(south)
  const w0 = Math.floor(west)
  const n0 = Math.floor(north)
  const e0 = Math.floor(east)

  for (let lat = s0; lat <= n0; lat += TILE_STEP_DEG) {
    for (let lng = w0; lng <= e0; lng += TILE_STEP_DEG) {
      tiles.push({
        key: `${lat},${lng}`,
        south: lat,
        west: lng,
        north: lat + TILE_STEP_DEG,
        east: lng + TILE_STEP_DEG,
      })
    }
  }
  return tiles
}

// ─── Water Tile Manager ─────────────────────────────────────────────────────

type TileCallback = (lakes: WaterBody[], rivers: River[], stats: WaterTileStats) => void

export class WaterTileManager {
  private worker: Worker | null = null
  private generation = 0
  private tileData = new Map<string, { lakes: WaterBody[]; rivers: River[] }>()
  private visibleKeys = new Set<string>()
  private callback: TileCallback | null = null
  private stats: WaterTileStats = {
    totalTiles: 0, cached: 0, fetched: 0,
    totalFetchMs: 0, totalLakes: 0, totalRivers: 0,
    pendingTiles: 0, generation: 0,
  }

  constructor() {
    this.spawnWorker()
  }

  private spawnWorker() {
    this.worker = new Worker(
      new URL('../workers/waterWorker.ts', import.meta.url),
      { type: 'module' },
    )

    this.worker.onmessage = (e: MessageEvent) => {
      const { type, generation } = e.data

      // Ignore stale generations
      if (generation !== this.generation) return

      if (type === 'tile-result') {
        const { key, lakes, rivers, fromCache, fetchMs } = e.data
        this.tileData.set(key, { lakes, rivers })
        this.stats.pendingTiles--

        if (fromCache) this.stats.cached++
        else {
          this.stats.fetched++
          this.stats.totalFetchMs += fetchMs
        }

        log.debug('Water tile received', { key, lakes: lakes.length, rivers: rivers.length, fromCache, fetchMs })

        // Emit merged results for all visible tiles so far
        this.emitMerged()
      } else if (type === 'all-complete') {
        const { stats: workerStats } = e.data
        this.stats.totalLakes = workerStats.totalLakes
        this.stats.totalRivers = workerStats.totalRivers
        this.stats.pendingTiles = 0
        log.info('Water tiles complete', {
          tiles: workerStats.totalTiles,
          cached: workerStats.cached,
          fetched: workerStats.fetched,
          fetchMs: workerStats.totalFetchMs,
          lakes: workerStats.totalLakes,
          rivers: workerStats.totalRivers,
        })
        this.emitMerged()
      } else if (type === 'error') {
        const { key, error } = e.data
        this.stats.pendingTiles--
        log.warn('Water tile error', { key, error })
      }
    }

    this.worker.onerror = (err) => {
      log.warn('Water worker error', { err: err.message })
    }
  }

  /** Set the callback for merged results */
  onResults(cb: TileCallback) {
    this.callback = cb
  }

  /** Request water tiles for a viewport bounding box */
  requestTiles(south: number, west: number, north: number, east: number) {
    const tiles = computeTiles(south, west, north, east)
    this.visibleKeys = new Set(tiles.map(t => t.key))

    // Filter to tiles not already in memory
    const needed = tiles.filter(t => !this.tileData.has(t.key))

    if (needed.length === 0) {
      // All tiles cached in memory — emit immediately
      this.emitMerged()
      return
    }

    // Bump generation to ignore stale results
    this.generation++
    this.stats = {
      totalTiles: tiles.length,
      cached: tiles.length - needed.length,  // already-in-memory count
      fetched: 0,
      totalFetchMs: 0,
      totalLakes: 0,
      totalRivers: 0,
      pendingTiles: needed.length,
      generation: this.generation,
    }

    // Emit what we have now (cached tiles), worker will fill in the rest
    this.emitMerged()

    log.info('Requesting water tiles', {
      total: tiles.length,
      needed: needed.length,
      cached: tiles.length - needed.length,
      generation: this.generation,
    })

    this.worker?.postMessage({
      type: 'fetch-tiles',
      tiles: needed,
      generation: this.generation,
    })
  }

  /** Merge all visible tiles and emit */
  private emitMerged() {
    if (!this.callback) return

    const allLakes: WaterBody[] = []
    const allRivers: River[] = []

    for (const key of this.visibleKeys) {
      const data = this.tileData.get(key)
      if (data) {
        allLakes.push(...data.lakes)
        allRivers.push(...data.rivers)
      }
    }

    // Sort lakes by polygon size (largest first)
    allLakes.sort((a, b) => b.polygon.length - a.polygon.length)

    // Update total stats
    this.stats.totalLakes = allLakes.length
    this.stats.totalRivers = allRivers.length

    this.callback(allLakes, allRivers, { ...this.stats })
  }

  /** Get current stats (for debug panel) */
  getStats(): WaterTileStats {
    return { ...this.stats }
  }

  /** Terminate the worker */
  destroy() {
    this.worker?.terminate()
    this.worker = null
    this.tileData.clear()
    this.visibleKeys.clear()
  }
}

// ─── Singleton ──────────────────────────────────────────────────────────────

let _manager: WaterTileManager | null = null

export function getWaterTileManager(): WaterTileManager {
  if (!_manager) {
    _manager = new WaterTileManager()
  }
  return _manager
}

// ─── Legacy API (for SCAN / EXPLORE) ────────────────────────────────────────

/**
 * Fetch all named water features within `radiusKm` of a point.
 * Uses the tiled worker under the hood — results arrive via the manager callback.
 * Returns a promise that resolves with merged results for backwards compatibility.
 */
export function fetchWaterNear(
  lat: number, lng: number, radiusKm: number,
): Promise<WaterNearResult> {
  const cosLat = Math.cos(lat * Math.PI / 180)
  const dLat = radiusKm / 111.132
  const dLng = radiusKm / (111.320 * cosLat)

  const south = lat - dLat
  const north = lat + dLat
  const west  = lng - dLng
  const east  = lng + dLng

  return new Promise((resolve) => {
    const mgr = getWaterTileManager()
    // One-shot callback for legacy API
    const prevCallback = mgr['callback']
    mgr.onResults((lakes, rivers) => {
      // Restore previous callback after one emission where all tiles are done
      if (mgr.getStats().pendingTiles === 0) {
        mgr.onResults(prevCallback ?? (() => {}))
        resolve({ lakes, rivers })
      }
    })
    mgr.requestTiles(south, west, north, east)
  })
}
