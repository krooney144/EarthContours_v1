/**
 * EarthContours — OpenStreetMap Water Feature Loader
 *
 * Unified fetcher for lakes AND rivers from OSM's Overpass API.
 * One function, one query, one cache entry per location.
 * Called by MAP, EXPLORE, and SCAN screens identically.
 *
 * Pattern mirrors peakLoader.ts exactly:
 *   fetchWaterNear(lat, lng, radiusKm) → { lakes, rivers }
 *
 * Cache strategy:
 *   - Results stored in IndexedDB keyed by rounded lat/lng string.
 *   - Cache TTL is 24 hours.
 *   - On Overpass failure returns empty arrays — callers degrade gracefully.
 *
 * Single Overpass query fetches:
 *   - way/relation["natural"="water"]["name"]  → lakes, reservoirs, ponds
 *   - way["waterway"="river"]["name"]          → rivers
 */

import { createLogger } from '../core/logger'
import type { WaterBody, River, LatLng } from '../core/types'

const log = createLogger('DATA:WATER_LOADER')

const OVERPASS_URL = 'https://overpass-api.de/api/interpreter'
const DB_NAME      = 'ec-water-v3'
const STORE_NAME   = 'water'
const CACHE_TTL_MS = 24 * 60 * 60 * 1000  // 24 h

// ─── Result Type ─────────────────────────────────────────────────────────────

export interface WaterNearResult {
  lakes:  WaterBody[]
  rivers: River[]
}

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

interface CachedEntry { data: WaterNearResult; timestamp: number }

async function getCached(key: string): Promise<WaterNearResult | null> {
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
          log.info('Water cache hit', { key, lakes: entry.data.lakes.length, rivers: entry.data.rivers.length })
          resolve(entry.data)
        }
      }
      req.onerror = () => resolve(null)
    })
  } catch { return null }
}

async function saveCache(key: string, data: WaterNearResult): Promise<void> {
  try {
    const db = await openDB()
    await new Promise<void>((resolve) => {
      const tx = db.transaction(STORE_NAME, 'readwrite')
      tx.objectStore(STORE_NAME).put({ data, timestamp: Date.now() }, key)
      tx.oncomplete = () => resolve()
      tx.onerror    = () => resolve()
    })
  } catch { /* non-fatal */ }
}

// ─── In-flight Dedup ─────────────────────────────────────────────────────────

const inFlight = new Map<string, Promise<WaterNearResult>>()

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

/** Core fetch: lakes + rivers in a bounding box, one Overpass query */
async function fetchWaterInBounds(
  south: number, west: number, north: number, east: number,
): Promise<WaterNearResult> {
  // Rounded cache key — same pattern as peakLoader
  const key = `${south.toFixed(1)},${west.toFixed(1)},${north.toFixed(1)},${east.toFixed(1)}`

  // In-flight dedup
  const existing = inFlight.get(key)
  if (existing) return existing

  const doFetch = async (): Promise<WaterNearResult> => {
    // IndexedDB cache
    const cached = await getCached(key)
    if (cached) return cached

    // Single Overpass query: lakes + rivers
    const query = `[out:json][timeout:60];
(
  way["natural"="water"]["name"](${south},${west},${north},${east});
  relation["natural"="water"]["name"](${south},${west},${north},${east});
  way["waterway"="river"]["name"](${south},${west},${north},${east});
);
out geom;`

    log.info('Fetching water features from Overpass', { south: south.toFixed(1), west: west.toFixed(1), north: north.toFixed(1), east: east.toFixed(1) })

    try {
      const resp = await fetch(OVERPASS_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        body: query,
      })
      if (!resp.ok) throw new Error(`Overpass HTTP ${resp.status}`)

      const data = (await resp.json()) as OverpassResponse

      const lakes:  WaterBody[] = []
      const rivers: River[]     = []

      for (const el of data.elements) {
        const tags = el.tags
        if (!tags?.name) continue

        // River (waterway=river)
        if (tags.waterway === 'river') {
          if (el.type === 'way' && el.geometry && el.geometry.length >= 2) {
            rivers.push({
              id:     `osm-w${el.id}`,
              name:   tags.name,
              points: el.geometry.map(g => ({ lat: g.lat, lng: g.lon })),
            })
          }
          continue
        }

        // Lake/reservoir/pond (natural=water)
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

        lakes.push({
          id:      `osm-${el.type[0]}${el.id}`,
          name:    tags.name,
          type:    classifyWater(tags),
          center:  centroid(polygon),
          polygon,
        })
      }

      // Sort lakes by polygon size (largest first) for rendering priority
      lakes.sort((a, b) => b.polygon.length - a.polygon.length)

      const result: WaterNearResult = { lakes, rivers }
      log.info('Water features fetched', { lakes: lakes.length, rivers: rivers.length, key })
      await saveCache(key, result)
      return result
    } catch (err) {
      log.warn('Water fetch failed', { err: String(err) })
      return { lakes: [], rivers: [] }
    }
  }

  const promise = doFetch().finally(() => { inFlight.delete(key) })
  inFlight.set(key, promise)
  return promise
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Fetch all named water features (lakes + rivers) within `radiusKm` of a point.
 * One Overpass query, one cache entry. Called identically by MAP, EXPLORE, SCAN.
 *
 * @param lat       Center latitude
 * @param lng       Center longitude
 * @param radiusKm  Search radius in kilometres (typically 300)
 * @returns { lakes: WaterBody[], rivers: River[] }
 */
export async function fetchWaterNear(
  lat: number, lng: number, radiusKm: number,
): Promise<WaterNearResult> {
  const cosLat = Math.cos(lat * Math.PI / 180)
  const dLat = radiusKm / 111.132
  const dLng = radiusKm / (111.320 * cosLat)
  return fetchWaterInBounds(lat - dLat, lng - dLng, lat + dLat, lng + dLng)
}
