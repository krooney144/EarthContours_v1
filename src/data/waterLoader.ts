/**
 * EarthContours — OpenStreetMap Water Body Loader
 *
 * Grid-cell based pipeline for worldwide lake/reservoir loading.
 * The world is divided into fixed grid cells. When the map viewport changes,
 * only uncached cells are fetched from OSM's Overpass API.
 *
 * Grid strategy:
 *   - World divided into CELL_SIZE_DEG × CELL_SIZE_DEG cells (3° × 3°)
 *   - Each cell cached independently in IndexedDB with 24h TTL
 *   - In-flight deduplication prevents duplicate requests
 *   - Zoom-gated: no fetching below zoom 9
 *
 * Zoom behaviour:
 *   - Zoom 1–8:  Skip entirely (lakes invisible at that scale)
 *   - Zoom 9–10: Named lakes only, minimum polygon size (≥10 vertices)
 *   - Zoom 11+:  All named lakes
 *
 * Cache strategy:
 *   - Results stored in IndexedDB keyed by cell coordinate string.
 *   - Cache TTL is 24 hours.
 *   - On Overpass failure returns empty array — callers show no lakes.
 */

import { createLogger } from '../core/logger'
import type { WaterBody, LatLng } from '../core/types'

const log = createLogger('DATA:WATER_LOADER')

const OVERPASS_URL = 'https://overpass-api.de/api/interpreter'
const DB_NAME      = 'ec-water-v2'
const STORE_NAME   = 'water-cells'
const CACHE_TTL_MS = 24 * 60 * 60 * 1000  // 24 h

/** Grid cell size in degrees. 3° ≈ 330 km at equator, ~200 km at 50°N.
 *  Large enough to avoid excessive queries, small enough for reasonable payloads. */
const CELL_SIZE_DEG = 3

// ─── IndexedDB helpers ────────────────────────────────────────────────────────

let _db: IDBDatabase | null = null

async function openDB(): Promise<IDBDatabase> {
  if (_db) return _db
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1)
    req.onupgradeneeded = (e) => {
      const db = (e.target as IDBOpenDBRequest).result
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME)
      }
    }
    req.onsuccess = (e) => { _db = (e.target as IDBOpenDBRequest).result; resolve(_db) }
    req.onerror   = ()  => reject(new Error('Water IDB unavailable'))
  })
}

interface CachedEntry { waterBodies: WaterBody[]; timestamp: number }

async function getCached(key: string): Promise<WaterBody[] | null> {
  try {
    const db = await openDB()
    return new Promise((resolve) => {
      const tx  = db.transaction(STORE_NAME, 'readonly')
      const req = tx.objectStore(STORE_NAME).get(key)
      req.onsuccess = () => {
        const entry = req.result as CachedEntry | undefined
        if (!entry || Date.now() - entry.timestamp > CACHE_TTL_MS) {
          resolve(null)
        } else {
          resolve(entry.waterBodies)
        }
      }
      req.onerror = () => resolve(null)
    })
  } catch { return null }
}

async function saveCache(key: string, waterBodies: WaterBody[]): Promise<void> {
  try {
    const db = await openDB()
    await new Promise<void>((resolve) => {
      const tx = db.transaction(STORE_NAME, 'readwrite')
      tx.objectStore(STORE_NAME).put({ waterBodies, timestamp: Date.now() }, key)
      tx.oncomplete = () => resolve()
      tx.onerror    = () => resolve()
    })
  } catch { /* non-fatal */ }
}

// ─── Grid Cell System ─────────────────────────────────────────────────────────

/** Cell coordinate: floor(lat/CELL_SIZE), floor(lng/CELL_SIZE) */
interface CellCoord {
  cellLat: number  // e.g. 13 for latitudes 39–42° (13×3=39)
  cellLng: number  // e.g. -36 for longitudes -108–-105° (-36×3=-108)
}

function cellKey(c: CellCoord): string {
  return `cell:${c.cellLat}:${c.cellLng}`
}

function cellBounds(c: CellCoord): { south: number; west: number; north: number; east: number } {
  return {
    south: c.cellLat * CELL_SIZE_DEG,
    west:  c.cellLng * CELL_SIZE_DEG,
    north: (c.cellLat + 1) * CELL_SIZE_DEG,
    east:  (c.cellLng + 1) * CELL_SIZE_DEG,
  }
}

/** Compute all grid cells that overlap a viewport bounding box */
function viewportToCells(south: number, west: number, north: number, east: number): CellCoord[] {
  const minCellLat = Math.floor(south / CELL_SIZE_DEG)
  const maxCellLat = Math.floor(north / CELL_SIZE_DEG)
  const minCellLng = Math.floor(west / CELL_SIZE_DEG)
  const maxCellLng = Math.floor(east / CELL_SIZE_DEG)

  const cells: CellCoord[] = []
  for (let cLat = minCellLat; cLat <= maxCellLat; cLat++) {
    for (let cLng = minCellLng; cLng <= maxCellLng; cLng++) {
      cells.push({ cellLat: cLat, cellLng: cLng })
    }
  }
  return cells
}

// ─── In-memory Cell Cache + In-flight Dedup ──────────────────────────────────

/** In-memory cache of already-fetched cells (avoids IndexedDB round-trip) */
const memoryCache = new Map<string, WaterBody[]>()

/** Promises for cells currently being fetched (deduplication) */
const inFlightCells = new Map<string, Promise<WaterBody[]>>()

// ─── Overpass Fetching ────────────────────────────────────────────────────────

interface OverpassGeomNode {
  lat: number
  lon: number
}

interface OverpassElement {
  type: string
  id:   number
  tags?: Record<string, string>
  geometry?: OverpassGeomNode[]
  members?: Array<{ type: string; ref: number; role: string; geometry?: OverpassGeomNode[] }>
}

interface OverpassResponse {
  elements: OverpassElement[]
}

/** Classify water body type from OSM tags */
function classifyWater(tags: Record<string, string>): WaterBody['type'] {
  const w = tags.water ?? ''
  if (w === 'reservoir' || tags.landuse === 'reservoir') return 'reservoir'
  if (w === 'pond') return 'pond'
  if (w === 'lake') return 'lake'
  return 'water'
}

/** Compute centroid of a polygon (simple average) */
function centroid(pts: LatLng[]): LatLng {
  let lat = 0, lng = 0
  for (const p of pts) { lat += p.lat; lng += p.lng }
  return { lat: lat / pts.length, lng: lng / pts.length }
}

/** Fetch all named water bodies in a single grid cell */
async function fetchCell(cell: CellCoord): Promise<WaterBody[]> {
  const key = cellKey(cell)

  // 1. Memory cache
  const mem = memoryCache.get(key)
  if (mem) return mem

  // 2. IndexedDB cache
  const cached = await getCached(key)
  if (cached) {
    memoryCache.set(key, cached)
    return cached
  }

  // 3. Fetch from Overpass
  const { south, west, north, east } = cellBounds(cell)

  const query = `[out:json][timeout:45];
(
  way["natural"="water"]["name"](${south},${west},${north},${east});
  relation["natural"="water"]["name"](${south},${west},${north},${east});
);
out geom;`

  log.info('Fetching water cell from Overpass', { key, south, west, north, east })

  try {
    const resp = await fetch(OVERPASS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: query,
    })
    if (!resp.ok) throw new Error(`Overpass HTTP ${resp.status}`)

    const data = (await resp.json()) as OverpassResponse

    const waterBodies: WaterBody[] = []

    for (const el of data.elements) {
      const tags = el.tags
      if (!tags?.name) continue

      let polygon: LatLng[] | null = null

      if (el.type === 'way' && el.geometry && el.geometry.length >= 4) {
        polygon = el.geometry.map(g => ({ lat: g.lat, lng: g.lon }))
      } else if (el.type === 'relation' && el.members) {
        const outer = el.members.find(m => m.role === 'outer' && m.geometry && m.geometry.length >= 4)
        if (outer?.geometry) {
          polygon = outer.geometry.map(g => ({ lat: g.lat, lng: g.lon }))
        }
      }

      if (!polygon || polygon.length < 4) continue

      waterBodies.push({
        id:      `osm-${el.type[0]}${el.id}`,
        name:    tags.name,
        type:    classifyWater(tags),
        center:  centroid(polygon),
        polygon,
      })
    }

    // Sort by polygon size (more vertices = likely bigger lake) so large lakes render first
    waterBodies.sort((a, b) => b.polygon.length - a.polygon.length)

    log.info('Water cell fetched', { key, count: waterBodies.length })
    memoryCache.set(key, waterBodies)
    await saveCache(key, waterBodies)
    return waterBodies
  } catch (err) {
    log.warn('Water cell fetch failed', { key, err: String(err) })
    return []
  }
}

/** Fetch a cell with in-flight deduplication */
function fetchCellDeduped(cell: CellCoord): Promise<WaterBody[]> {
  const key = cellKey(cell)
  const existing = inFlightCells.get(key)
  if (existing) return existing

  const promise = fetchCell(cell).finally(() => {
    inFlightCells.delete(key)
  })
  inFlightCells.set(key, promise)
  return promise
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Fetch water bodies visible in a map viewport.
 * Grid-cell based: only fetches cells not already cached.
 *
 * @param south  - Viewport south latitude
 * @param west   - Viewport west longitude
 * @param north  - Viewport north latitude
 * @param east   - Viewport east longitude
 * @param zoom   - Current map zoom level (controls filtering)
 * @returns Merged, deduplicated water bodies for the viewport
 */
export async function fetchWaterBodiesForViewport(
  south: number, west: number, north: number, east: number,
  zoom: number,
): Promise<WaterBody[]> {
  // Zoom gate: no water below zoom 9
  if (zoom < 9) return []

  const cells = viewportToCells(south, west, north, east)

  // Cap cells to avoid huge queries when zoomed out at z9
  // At z9, viewport is ~10° wide → max ~16 cells (3° grid). Allow up to 20.
  if (cells.length > 20) {
    log.warn('Too many water cells for viewport, trimming', { requested: cells.length })
    cells.length = 20
  }

  log.info('Water viewport query', { zoom, cells: cells.length, south: south.toFixed(1), north: north.toFixed(1), west: west.toFixed(1), east: east.toFixed(1) })

  // Fetch all needed cells in parallel
  const results = await Promise.all(cells.map(c => fetchCellDeduped(c)))

  // Merge all cells into one array
  const all: WaterBody[] = []
  const seenIds = new Set<string>()
  for (const cellBodies of results) {
    for (const wb of cellBodies) {
      if (seenIds.has(wb.id)) continue
      seenIds.add(wb.id)

      // Zoom-based filtering:
      // z9–10: only lakes with enough detail (≥10 polygon vertices = larger lakes)
      if (zoom <= 10 && wb.polygon.length < 10) continue

      all.push(wb)
    }
  }

  // Sort by polygon size (largest first) for rendering priority
  all.sort((a, b) => b.polygon.length - a.polygon.length)

  log.info('Water viewport merged', { total: all.length, cells: cells.length })
  return all
}

/**
 * Legacy convenience wrapper: fetch water bodies within `radiusKm` of a lat/lng.
 * Still useful for SCAN screen or other non-viewport contexts.
 */
export async function fetchWaterBodiesNear(
  lat: number, lng: number, radiusKm: number,
): Promise<WaterBody[]> {
  const cosLat = Math.cos(lat * Math.PI / 180)
  const dLat = radiusKm / 111.132
  const dLng = radiusKm / (111.320 * cosLat)
  return fetchWaterBodiesForViewport(
    lat - dLat, lng - dLng, lat + dLat, lng + dLng,
    11,  // treat as high zoom so all named lakes are returned
  )
}

/** Get count of cached cells (for debug panel) */
export function getWaterCacheStats(): { memoryCells: number; inFlight: number } {
  return {
    memoryCells: memoryCache.size,
    inFlight: inFlightCells.size,
  }
}
