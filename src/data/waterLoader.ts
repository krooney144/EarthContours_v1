/**
 * EarthContours — OpenStreetMap Water Body Loader
 *
 * Fetches lake/reservoir polygons from OSM's Overpass API.
 * Modeled directly on peakLoader.ts — same cache strategy, same error handling.
 *
 * Cache strategy:
 *   - Results stored in IndexedDB keyed by rounded bounding-box string.
 *   - Cache TTL is 24 hours.
 *   - On Overpass failure returns empty array — callers show no lakes.
 *
 * Overpass query: all ways with natural=water + name tag, returning full geometry.
 * Relations (multipolygon lakes) included via `rel["natural"="water"]` → outer ways.
 */

import { createLogger } from '../core/logger'
import type { WaterBody, LatLng } from '../core/types'

const log = createLogger('DATA:WATER_LOADER')

const OVERPASS_URL = 'https://overpass-api.de/api/interpreter'
const DB_NAME      = 'ec-water-v1'
const STORE_NAME   = 'water'
const CACHE_TTL_MS = 24 * 60 * 60 * 1000  // 24 h

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
          log.info('Water cache hit', { key, count: entry.waterBodies.length })
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

/**
 * Fetch water body polygons from OpenStreetMap Overpass API for a bounding box.
 * Water bodies must have a `name` tag.
 * Results cached in IndexedDB for 24 h.
 */
export async function fetchWaterBodiesInBounds(
  south: number, west: number, north: number, east: number,
): Promise<WaterBody[]> {
  const key = `${south.toFixed(1)},${west.toFixed(1)},${north.toFixed(1)},${east.toFixed(1)}`

  const cached = await getCached(key)
  if (cached) return cached

  // Query both ways and relations with full geometry.
  // `out geom` returns geometry inline so we don't need a second request.
  const query = `[out:json][timeout:45];
(
  way["natural"="water"]["name"](${south},${west},${north},${east});
  relation["natural"="water"]["name"](${south},${west},${north},${east});
);
out geom;`

  log.info('Fetching water bodies from Overpass', { south, west, north, east })

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
        // Simple way — geometry is the polygon ring
        polygon = el.geometry.map(g => ({ lat: g.lat, lng: g.lon }))
      } else if (el.type === 'relation' && el.members) {
        // Multipolygon relation — use the first outer ring
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

    log.info('Overpass water bodies fetched', { count: waterBodies.length, key })
    await saveCache(key, waterBodies)
    return waterBodies
  } catch (err) {
    log.warn('Overpass water fetch failed', { err: String(err) })
    return []
  }
}

/**
 * Convenience wrapper: fetch water bodies within `radiusKm` of a lat/lng.
 */
export async function fetchWaterBodiesNear(
  lat: number, lng: number, radiusKm: number,
): Promise<WaterBody[]> {
  const cosLat = Math.cos(lat * Math.PI / 180)
  const dLat = radiusKm / 111.132
  const dLng = radiusKm / (111.320 * cosLat)
  return fetchWaterBodiesInBounds(lat - dLat, lng - dLng, lat + dLat, lng + dLng)
}
