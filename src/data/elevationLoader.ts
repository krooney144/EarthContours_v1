/**
 * EarthContours — Elevation Tile Loader
 *
 * Three-level fallback chain for elevation data:
 *
 *   1. IndexedDB cache   — Fastest. Data already on device from prior session.
 *   2. Local file        — /public/tiles/elevation/{z}/{x}/{y}.png
 *                          Pre-bundled tiles for offline/no-cell-service use.
 *                          Add tiles here to make a region work fully offline.
 *   3. AWS Terrarium     — Network fallback. Public AWS open dataset, no API key.
 *                          https://s3.amazonaws.com/elevation-tiles-prod/terrarium/
 *
 * Tile format: Terrarium RGB PNG
 *   elevation_meters = (R × 256 + G + B / 256) − 32768
 *
 * Architecture goal: Adding offline support in a future session only requires
 * placing tile PNG files in /public/tiles/elevation/ — no code changes needed.
 *
 * Session 2 upgrade path:
 *   - Replace AWS URL with Copernicus GLO-10 MBTiles server
 *   - LocalDB cache already handles deduplication
 */

import { createLogger } from '../core/logger'
import { TileLoadError } from '../core/errors'
import type { Region } from '../core/types'
import { latLngToTile } from '../core/utils'

const log = createLogger('DATA:ELEVATION_LOADER')

// ─── Constants ────────────────────────────────────────────────────────────────

/** AWS public terrain tile dataset — Terrarium RGB format */
const AWS_TERRARIUM_BASE = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium'

/** Local offline tile path — place pre-downloaded tiles here for offline use */
const LOCAL_TILE_BASE = '/tiles/elevation'

/** IndexedDB database name and version */
const DB_NAME = 'ec-elevation-v1'
const DB_VERSION = 1
const STORE_NAME = 'tiles'

/** Default zoom level for terrain fetch — z=10 gives ~150m/pixel for good terrain detail */
export const TERRAIN_ZOOM = 10

/**
 * Calculate optimal tile zoom level based on the physical size of the selected area.
 * Smaller areas get higher zoom = more terrain detail per grid cell.
 *
 * The output grid is always 256×256, so higher zoom means each grid cell
 * represents a smaller real-world area with more detail.
 *
 *   < 10 km  → z14  (~20m/px)
 *   10-30 km → z13  (~40m/px)
 *   30-80 km → z12  (~80m/px)
 *   80-200km → z11  (~150m/px)
 *   200-400km → z10 (~300m/px)
 *   > 400 km → z9   (~600m/px)
 */
export function adaptiveZoomForArea(maxSideKm: number): number {
  if (maxSideKm < 10)  return 14
  if (maxSideKm < 30)  return 13
  if (maxSideKm < 80)  return 12
  if (maxSideKm < 200) return 11
  if (maxSideKm < 400) return 10
  return 9
}

// ─── Types ────────────────────────────────────────────────────────────────────

interface CachedTile {
  pixels: Uint8ClampedArray
  width: number
  height: number
  timestamp: number
}

// ─── Module-level caches ──────────────────────────────────────────────────────

/** In-memory tile cache — fastest, but lost on page refresh */
const memoryCache = new Map<string, CachedTile>()

/** IndexedDB instance — opened on first use */
let _db: IDBDatabase | null = null

// ─── IndexedDB helpers ────────────────────────────────────────────────────────

async function openDB(): Promise<IDBDatabase> {
  if (_db) return _db

  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)

    req.onupgradeneeded = (e) => {
      const db = (e.target as IDBOpenDBRequest).result
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME)
        log.info('IndexedDB elevation store created')
      }
    }

    req.onsuccess = (e) => {
      _db = (e.target as IDBOpenDBRequest).result
      log.info('IndexedDB opened for elevation cache')
      resolve(_db)
    }

    req.onerror = (e) => {
      log.warn('IndexedDB unavailable — will skip disk cache', e)
      reject(new Error('IndexedDB unavailable'))
    }
  })
}

async function getFromIDB(key: string): Promise<CachedTile | null> {
  try {
    const db = await openDB()
    return new Promise((resolve) => {
      const tx = db.transaction(STORE_NAME, 'readonly')
      const req = tx.objectStore(STORE_NAME).get(key)
      req.onsuccess = () => resolve(req.result ?? null)
      req.onerror = () => resolve(null)
    })
  } catch {
    return null
  }
}

async function saveToIDB(key: string, tile: CachedTile): Promise<void> {
  try {
    const db = await openDB()
    return new Promise((resolve) => {
      const tx = db.transaction(STORE_NAME, 'readwrite')
      tx.objectStore(STORE_NAME).put(tile, key)
      tx.oncomplete = () => resolve()
      tx.onerror = () => {
        log.warn('Failed to save tile to IndexedDB', { key })
        resolve()
      }
    })
  } catch {
    // Non-fatal — just means the tile won't be cached
  }
}

// ─── Tile Image Loading ───────────────────────────────────────────────────────

/**
 * Load a PNG URL into an ImageData object via a canvas.
 * Setting crossOrigin='anonymous' is required for reading pixels from
 * external URLs (like AWS S3) without a CORS error.
 */
async function loadImageToPixels(url: string): Promise<CachedTile> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.crossOrigin = 'anonymous'

    img.onload = () => {
      try {
        const canvas = document.createElement('canvas')
        canvas.width = img.width
        canvas.height = img.height
        const ctx = canvas.getContext('2d')
        if (!ctx) throw new Error('Canvas 2D context unavailable')

        ctx.drawImage(img, 0, 0)

        // getImageData throws SecurityError if CORS is violated
        const imageData = ctx.getImageData(0, 0, img.width, img.height)

        resolve({
          pixels: imageData.data,
          width: img.width,
          height: img.height,
          timestamp: Date.now(),
        })
      } catch (err) {
        reject(err)
      }
    }

    img.onerror = () => reject(new Error(`Failed to load image: ${url}`))
    img.src = url
  })
}

// ─── Elevation Decoding ───────────────────────────────────────────────────────

/**
 * Decode a Terrarium-format tile into an array of elevation values (meters).
 *
 * Terrarium encoding formula (from Mapzen/AWS documentation):
 *   elevation = (R * 256 + G + B / 256) − 32768
 *
 * This allows encoding elevations from −32768m to +32768m, covering
 * everything from ocean trenches to mountain peaks.
 */
export function decodeTerrarium(tile: CachedTile): Float32Array {
  const { pixels, width, height } = tile
  const count = width * height
  const elevations = new Float32Array(count)

  for (let i = 0; i < count; i++) {
    const r = pixels[i * 4]
    const g = pixels[i * 4 + 1]
    const b = pixels[i * 4 + 2]
    // Alpha channel (pixels[i*4+3]) is unused in Terrarium format
    elevations[i] = r * 256 + g + b / 256 - 32768
  }

  return elevations
}

// ─── Main Tile Loader ─────────────────────────────────────────────────────────

/**
 * Load a single elevation tile — tries all three sources in priority order.
 *
 * The key design insight: callers don't need to know WHERE the data comes from.
 * Whether it's cached from last session, locally bundled for offline use,
 * or fetched live from AWS — the returned tile data is always the same format.
 */
export async function loadElevationTile(
  z: number, x: number, y: number,
): Promise<CachedTile> {
  const key = `${z}/${x}/${y}`
  const endTiming = log.time(`loadElevationTile(${key})`)

  // ── Tier 1: In-memory cache (fastest — survives only for this page load) ──
  const memHit = memoryCache.get(key)
  if (memHit) {
    log.debug('[TIER 1 — MEMORY] Tile served from in-process cache', { key })
    endTiming()
    return memHit
  }

  // ── Tier 2: IndexedDB (persistent browser cache) ──────────────────────────
  const idbHit = await getFromIDB(key)
  if (idbHit) {
    log.info('[TIER 2 — IndexedDB] Tile served from browser cache', { key })
    memoryCache.set(key, idbHit)  // Promote to memory cache
    endTiming()
    return idbHit
  }

  // ── Tier 3: Local file (offline bundle) ───────────────────────────────────
  const localUrl = `${LOCAL_TILE_BASE}/${key}.png`
  try {
    const tile = await loadImageToPixels(localUrl)
    log.info('[TIER 3 — LOCAL FILE] Tile loaded from offline bundle', { key, localUrl })
    memoryCache.set(key, tile)
    await saveToIDB(key, tile)  // Cache it for next time
    endTiming()
    return tile
  } catch {
    log.debug('Tier 3 miss — no local file (expected for live regions)', { key })
  }

  // ── Tier 4: AWS Terrarium (live network) ──────────────────────────────────
  const awsUrl = `${AWS_TERRARIUM_BASE}/${key}.png`
  try {
    log.info('[TIER 4 — AWS TERRARIUM] Fetching live elevation tile', { key, awsUrl })
    const tile = await loadImageToPixels(awsUrl)
    memoryCache.set(key, tile)
    await saveToIDB(key, tile)  // Cache locally so next load uses Tier 2
    log.info('[TIER 4 — AWS TERRARIUM] Tile fetched and cached to IndexedDB', { key })
    endTiming()
    return tile
  } catch (err) {
    endTiming()
    throw new TileLoadError(awsUrl, err)
  }
}

// ─── Region Elevation Grid ────────────────────────────────────────────────────

/**
 * Load a full elevation grid for a region by fetching all necessary tiles.
 *
 * Strategy:
 * 1. Calculate which tiles at TERRAIN_ZOOM cover the region bounds + a margin
 * 2. Fetch all tiles in parallel (respecting browser connection limits)
 * 3. Stitch them into one large pixel grid
 * 4. Decode from Terrarium to meters
 * 5. Downsample to the target gridSize using bilinear interpolation
 *
 * @param region  - Geographic bounds defining the terrain area
 * @param gridSize - Output grid dimensions (e.g., 128 → 128×128)
 * @param onProgress - Called with 0-1 progress as tiles load
 * @returns Float32Array of elevation values in meters, row-major order
 */
export async function loadRegionElevation(
  region: Region,
  gridSize: number,
  onProgress: (p: number) => void,
  zoomOverride?: number,
): Promise<Float32Array> {
  const endTiming = log.time(`loadRegionElevation(${region.id})`)
  const z = zoomOverride ?? TERRAIN_ZOOM

  log.info('━━━ ELEVATION LOAD START ━━━', {
    region: region.id,
    zoom: z,
    gridSize: `${gridSize}×${gridSize}`,
    source: 'attempting Tier 1→2→3→4 (memory → IDB → local → AWS Terrarium)',
  })

  // ── Calculate tile range ──────────────────────────────────────────────────
  const margin = 0.5  // degrees of margin around bounds to avoid edge artifacts
  const { north, south, east, west } = region.bounds

  const tileNW = latLngToTile(north + margin, west - margin, z)
  const tileSE = latLngToTile(south - margin, east + margin, z)

  // Tile range (inclusive)
  const tileX0 = tileNW.x
  const tileX1 = tileSE.x
  const tileY0 = tileNW.y
  const tileY1 = tileSE.y

  const tilesWide = tileX1 - tileX0 + 1
  const tilesTall = tileY1 - tileY0 + 1
  const totalTiles = tilesWide * tilesTall

  log.info('Tile range calculated', {
    region: region.id,
    zoom: z,
    tileRange: `${tileX0}-${tileX1} × ${tileY0}-${tileY1}`,
    tilesWide,
    tilesTall,
    totalTiles,
  })

  onProgress(0.05)

  // ── Fetch all tiles in parallel ───────────────────────────────────────────
  const tileGrid: Array<Array<CachedTile | null>> = Array.from(
    { length: tilesTall },
    () => new Array(tilesWide).fill(null),
  )

  let loadedCount = 0
  const tilePromises: Promise<void>[] = []

  for (let ty = 0; ty < tilesTall; ty++) {
    for (let tx = 0; tx < tilesWide; tx++) {
      const tileX = tileX0 + tx
      const tileY = tileY0 + ty

      const promise = loadElevationTile(z, tileX, tileY)
        .then((tile) => {
          tileGrid[ty][tx] = tile
          loadedCount++
          onProgress(0.05 + 0.7 * (loadedCount / totalTiles))
          log.debug('Tile loaded', { tileX, tileY, loaded: loadedCount, total: totalTiles })
        })
        .catch((err) => {
          log.warn('Tile load failed — will interpolate gap', { tileX, tileY, err })
          loadedCount++
          onProgress(0.05 + 0.7 * (loadedCount / totalTiles))
        })

      tilePromises.push(promise)
    }
  }

  await Promise.all(tilePromises)

  // Count how many tiles actually loaded vs failed
  let successfulTiles = 0
  for (let ty = 0; ty < tilesTall; ty++) {
    for (let tx = 0; tx < tilesWide; tx++) {
      if (tileGrid[ty][tx] !== null) successfulTiles++
    }
  }
  const failedTiles = totalTiles - successfulTiles

  log.info('Tile batch complete', {
    total: totalTiles,
    successful: successfulTiles,
    failed: failedTiles,
    successRate: `${((successfulTiles / totalTiles) * 100).toFixed(0)}%`,
  })

  // If every tile failed (e.g. CORS blocked, network down), throw so the caller
  // can fall back to simulated terrain — don't silently return garbage −32768m data.
  if (successfulTiles === 0) {
    throw new TileLoadError(
      `region/${region.id}`,
      new Error(`All ${totalTiles} elevation tiles failed to load — AWS unreachable or CORS blocked`),
    )
  }

  onProgress(0.78)

  // ── Stitch tiles into one large pixel grid ────────────────────────────────
  const TILE_PX = 256  // Terrarium tiles are always 256×256
  const stitchedW = tilesWide * TILE_PX
  const stitchedH = tilesTall * TILE_PX

  log.debug('Stitching tiles', { stitchedW, stitchedH })

  const stitchedPixels = new Uint8ClampedArray(stitchedW * stitchedH * 4)

  for (let ty = 0; ty < tilesTall; ty++) {
    for (let tx = 0; tx < tilesWide; tx++) {
      const tile = tileGrid[ty][tx]
      if (!tile) continue  // Skip failed tiles

      const offsetX = tx * TILE_PX
      const offsetY = ty * TILE_PX

      for (let py = 0; py < TILE_PX; py++) {
        for (let px = 0; px < TILE_PX; px++) {
          const srcIdx = (py * tile.width + px) * 4
          const dstIdx = ((offsetY + py) * stitchedW + (offsetX + px)) * 4
          stitchedPixels[dstIdx]     = tile.pixels[srcIdx]
          stitchedPixels[dstIdx + 1] = tile.pixels[srcIdx + 1]
          stitchedPixels[dstIdx + 2] = tile.pixels[srcIdx + 2]
          stitchedPixels[dstIdx + 3] = 255
        }
      }
    }
  }

  onProgress(0.87)

  // ── Decode Terrarium to elevation values ──────────────────────────────────
  const stitchedTile: CachedTile = {
    pixels: stitchedPixels,
    width: stitchedW,
    height: stitchedH,
    timestamp: Date.now(),
  }
  const stitchedElevations = decodeTerrarium(stitchedTile)

  // Use a loop instead of spread to avoid stack overflow on multi-million-sample arrays.
  // Math.min(...Float32Array_of_31M) throws RangeError in every browser.
  let stitchedMin = Infinity, stitchedMax = -Infinity
  for (let i = 0; i < stitchedElevations.length; i++) {
    if (stitchedElevations[i] < stitchedMin) stitchedMin = stitchedElevations[i]
    if (stitchedElevations[i] > stitchedMax) stitchedMax = stitchedElevations[i]
  }
  log.debug('Terrarium decoded', {
    samples: stitchedElevations.length,
    min: stitchedMin.toFixed(0),
    max: stitchedMax.toFixed(0),
  })

  onProgress(0.92)

  // ── Compute crop rectangle — clip to exact region bounds ──────────────────
  // The stitched grid extends beyond the region bounds by the 0.5° margin
  // (plus tile-alignment overshoot).  Downsample only the sub-rectangle that
  // corresponds to the declared region bounds so the output 256×256 grid
  // covers exactly what meshData.bounds says — GPS ↔ grid index alignment.
  const scale = Math.pow(2, z)
  const worldXForLng = (lng: number) => (lng + 180) / 360 * 256 * scale
  const worldYForLat = (lat: number) => {
    const latRad = (lat * Math.PI) / 180
    return (1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2 * 256 * scale
  }
  const originX = tileX0 * 256  // world-pixel X of stitched grid left edge
  const originY = tileY0 * 256  // world-pixel Y of stitched grid top edge

  const cropLeft   = worldXForLng(west)  - originX
  const cropRight  = worldXForLng(east)  - originX
  const cropTop    = worldYForLat(north) - originY
  const cropBottom = worldYForLat(south) - originY

  log.debug('Crop rectangle (region bounds within stitched grid)', {
    cropLeft:   cropLeft.toFixed(1),
    cropRight:  cropRight.toFixed(1),
    cropTop:    cropTop.toFixed(1),
    cropBottom: cropBottom.toFixed(1),
    stitchedW,
    stitchedH,
  })

  // ── Downsample to target gridSize using bilinear interpolation ─────────────
  const output = downsampleBilinear(
    stitchedElevations, stitchedW, stitchedH, gridSize, gridSize,
    cropLeft, cropTop, cropRight, cropBottom,
  )

  onProgress(1.0)
  endTiming()

  // Log stats on the real data
  let minE = Infinity, maxE = -Infinity
  for (let i = 0; i < output.length; i++) {
    if (output[i] < minE) minE = output[i]
    if (output[i] > maxE) maxE = output[i]
  }
  log.info('━━━ ELEVATION LOAD COMPLETE ━━━', {
    region: region.id,
    source: 'AWS Terrarium RGB tiles (real DEM data)',
    gridSize: `${gridSize}×${gridSize}`,
    minElev: `${minE.toFixed(0)}m`,
    maxElev: `${maxE.toFixed(0)}m`,
    range: `${(maxE - minE).toFixed(0)}m`,
    note: minE > 1000 ? 'Plausible Colorado elevations ✓' : 'WARNING: elevations look suspect — check CORS',
  })

  return output
}

// ─── Bilinear Downsampling ────────────────────────────────────────────────────

/**
 * Downsample a large elevation grid to a smaller target size.
 * Uses bilinear interpolation for smooth, artifact-free results.
 *
 * When crop coordinates are provided, the output grid maps to the
 * specified sub-rectangle of the source instead of the full extent.
 * This lets us stitch tiles with a margin (for interpolation at edges)
 * but output a grid that covers exactly the declared region bounds.
 */
function downsampleBilinear(
  src: Float32Array,
  srcW: number, srcH: number,
  dstW: number, dstH: number,
  cropX0 = 0, cropY0 = 0,
  cropX1 = srcW - 1, cropY1 = srcH - 1,
): Float32Array {
  const dst = new Float32Array(dstW * dstH)

  for (let dy = 0; dy < dstH; dy++) {
    for (let dx = 0; dx < dstW; dx++) {
      // Map destination pixel to source coordinates within the crop rectangle
      const sx = cropX0 + (dx / (dstW - 1)) * (cropX1 - cropX0)
      const sy = cropY0 + (dy / (dstH - 1)) * (cropY1 - cropY0)

      const x0 = Math.floor(sx)
      const y0 = Math.floor(sy)
      const x1 = Math.min(x0 + 1, srcW - 1)
      const y1 = Math.min(y0 + 1, srcH - 1)

      // Fractional parts
      const fx = sx - x0
      const fy = sy - y0

      // Four corner values
      const v00 = src[y0 * srcW + x0]
      const v10 = src[y0 * srcW + x1]
      const v01 = src[y1 * srcW + x0]
      const v11 = src[y1 * srcW + x1]

      // Bilinear blend
      dst[dy * dstW + dx] =
        v00 * (1 - fx) * (1 - fy) +
        v10 * fx       * (1 - fy) +
        v01 * (1 - fx) * fy +
        v11 * fx       * fy
    }
  }

  return dst
}

// ─── Elevation Sampling ───────────────────────────────────────────────────────

/**
 * Sample the elevation grid at a given latitude/longitude.
 * Used by the SCAN screen to look up ground elevation at any point.
 *
 * @param lat        - Latitude to sample
 * @param lng        - Longitude to sample
 * @param elevations - The flat elevation grid
 * @param gridW      - Grid width (columns)
 * @param gridH      - Grid height (rows)
 * @param region     - Region bounds (defines the geographic coverage)
 * @returns Elevation in meters, or 2400 (Colorado base) as fallback
 */
export function sampleElevationAt(
  lat: number, lng: number,
  elevations: Float32Array,
  gridW: number, gridH: number,
  region: Region,
): number {
  const { north, south, east, west } = region.bounds

  // Normalize lat/lng to 0-1 range within bounds
  const nx = (lng - west) / (east - west)
  const ny = (north - lat) / (north - south)

  if (nx < 0 || nx > 1 || ny < 0 || ny > 1) {
    // Outside the region — return region's base elevation
    return elevations[Math.floor(gridH / 2) * gridW + Math.floor(gridW / 2)] ?? 2400
  }

  // Bilinear interpolation
  const sx = nx * (gridW - 1)
  const sy = ny * (gridH - 1)
  const x0 = Math.floor(sx), x1 = Math.min(x0 + 1, gridW - 1)
  const y0 = Math.floor(sy), y1 = Math.min(y0 + 1, gridH - 1)
  const fx = sx - x0, fy = sy - y0

  return (
    elevations[y0 * gridW + x0] * (1 - fx) * (1 - fy) +
    elevations[y0 * gridW + x1] * fx       * (1 - fy) +
    elevations[y1 * gridW + x0] * (1 - fx) * fy +
    elevations[y1 * gridW + x1] * fx       * fy
  )
}
