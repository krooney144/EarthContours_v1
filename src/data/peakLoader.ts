/**
 * EarthContours — OpenStreetMap Peak Data Loader
 *
 * Fetches mountain peak data from OSM's Overpass API for any location worldwide.
 * Enables worldwide peak labeling in the SCAN screen — not limited to the 3
 * hardcoded regions.
 *
 * Cache strategy:
 *   - Results are stored in IndexedDB keyed by a rounded bounding-box string.
 *   - Cache TTL is 24 hours (peaks don't move often).
 *   - On Overpass failure the function returns an empty array — callers should
 *     fall back to the hardcoded terrainStore peaks.
 *
 * Overpass query: all natural=peak nodes with an elevation AND name tag.
 */

import { createLogger } from '../core/logger'
import type { Peak } from '../core/types'

const log = createLogger('DATA:PEAK_LOADER')

const OVERPASS_URL = 'https://overpass-api.de/api/interpreter'
const DB_NAME    = 'ec-peaks-v1'
const STORE_NAME = 'peaks'
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
    req.onerror   = ()  => reject(new Error('Peak IDB unavailable'))
  })
}

interface CachedEntry { peaks: Peak[]; timestamp: number }

async function getCached(key: string): Promise<Peak[] | null> {
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
          log.info('Peak cache hit', { key, count: entry.peaks.length })
          resolve(entry.peaks)
        }
      }
      req.onerror = () => resolve(null)
    })
  } catch { return null }
}

async function saveCache(key: string, peaks: Peak[]): Promise<void> {
  try {
    const db = await openDB()
    await new Promise<void>((resolve) => {
      const tx = db.transaction(STORE_NAME, 'readwrite')
      tx.objectStore(STORE_NAME).put({ peaks, timestamp: Date.now() }, key)
      tx.oncomplete = () => resolve()
      tx.onerror    = () => resolve()
    })
  } catch { /* non-fatal */ }
}

// ─── Overpass Fetching ────────────────────────────────────────────────────────

interface OverpassElement {
  type: string
  id:   number
  lat:  number
  lon:  number
  tags: Record<string, string>
}

interface OverpassResponse {
  elements: OverpassElement[]
}

/**
 * Fetch mountain peaks from OpenStreetMap Overpass API for a bounding box.
 * Peaks must have both `name` and `ele` tags.
 * Results cached in IndexedDB for 24 h.
 */
export async function fetchPeaksInBounds(
  south: number, west: number, north: number, east: number,
): Promise<Peak[]> {
  // Round to 1 decimal degree for a stable cache key.
  // Two viewpoints within 0.1° share the same key → avoids fetching dozens of
  // overlapping boxes as the user moves around the same region.
  const key = `${south.toFixed(1)},${west.toFixed(1)},${north.toFixed(1)},${east.toFixed(1)}`

  const cached = await getCached(key)
  if (cached) return cached

  const query = `[out:json][timeout:30];
node["natural"="peak"]["ele"]["name"](${south},${west},${north},${east});
out body;`

  log.info('Fetching peaks from Overpass', { south, west, north, east })

  try {
    const resp = await fetch(OVERPASS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: query,
    })
    if (!resp.ok) throw new Error(`Overpass HTTP ${resp.status}`)

    const data = (await resp.json()) as OverpassResponse

    const peaks: Peak[] = data.elements
      .filter(e => e.tags?.ele && e.tags?.name)
      .map(e => {
        // Overpass `ele` can be "4399", "4399 m", "14440 ft" etc.
        const raw = e.tags.ele.replace(/[^0-9.]/g, '')
        let elev = parseFloat(raw)
        // If the tag explicitly says 'ft', convert to metres
        if (e.tags.ele.toLowerCase().includes('ft')) elev *= 0.3048
        return {
          id:          `osm-${e.id}`,
          name:        e.tags.name,
          lat:         e.lat,
          lng:         e.lon,
          elevation_m: elev,
        } satisfies Peak
      })
      .filter(p => p.elevation_m > 0 && !isNaN(p.elevation_m))

    // Sort by elevation so the most prominent peaks render on top
    peaks.sort((a, b) => b.elevation_m - a.elevation_m)

    log.info('Overpass peaks fetched', { count: peaks.length, key })
    await saveCache(key, peaks)
    return peaks
  } catch (err) {
    log.warn('Overpass fetch failed — falling back to hardcoded peaks', { err: String(err) })
    return []
  }
}

/**
 * Convenience wrapper: fetch peaks within `radiusKm` of a lat/lng.
 * The radius is converted to a bounding box (flat-earth approximation —
 * accurate to < 0.5 % at these scales).
 */
export async function fetchPeaksNear(
  lat: number, lng: number, radiusKm: number,
): Promise<Peak[]> {
  const cosLat = Math.cos(lat * Math.PI / 180)
  const dLat = radiusKm / 111.132
  const dLng = radiusKm / (111.320 * cosLat)
  return fetchPeaksInBounds(lat - dLat, lng - dLng, lat + dLat, lng + dLng)
}
