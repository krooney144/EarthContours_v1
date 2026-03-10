/**
 * EarthContours — Natural Earth GeoJSON Loader
 *
 * 3-tier cache for Natural Earth data files:
 *   1. In-memory cache (instant, current session only)
 *   2. IndexedDB (persistent, survives page reloads)
 *   3. Fetch from /public/geo/ (first load only, ~5-6 MB gzipped total)
 *
 * Each layer is a single GeoJSON FeatureCollection file.
 * Once cached in IndexedDB, the file is never fetched again.
 */

import { createLogger } from '../core/logger'

const log = createLogger('GEO:LOADER')

// ─── Types ───────────────────────────────────────────────────────────────────

export type GeoLayerName = 'rivers' | 'lakes' | 'glaciers' | 'coastline'

export interface GeoJSONFeatureCollection {
  type: 'FeatureCollection'
  features: GeoJSONFeature[]
}

export interface GeoJSONFeature {
  type: 'Feature'
  properties: Record<string, unknown>
  geometry: GeoJSONGeometry
}

export interface GeoJSONGeometry {
  type: string
  coordinates: unknown
}

// ─── In-Memory Cache (Tier 1) ────────────────────────────────────────────────

const memoryCache = new Map<GeoLayerName, GeoJSONFeatureCollection>()

// ─── IndexedDB (Tier 2) ─────────────────────────────────────────────────────

const DB_NAME = 'ec-geo-v1'
const DB_VERSION = 1
const STORE_NAME = 'layers'

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME)
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

async function getFromIDB(layer: GeoLayerName): Promise<GeoJSONFeatureCollection | null> {
  try {
    const db = await openDB()
    return new Promise((resolve) => {
      const tx = db.transaction(STORE_NAME, 'readonly')
      const store = tx.objectStore(STORE_NAME)
      const req = store.get(layer)
      req.onsuccess = () => resolve(req.result ?? null)
      req.onerror = () => resolve(null)
    })
  } catch {
    return null
  }
}

async function putToIDB(layer: GeoLayerName, data: GeoJSONFeatureCollection): Promise<void> {
  try {
    const db = await openDB()
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite')
      const store = tx.objectStore(STORE_NAME)
      const req = store.put(data, layer)
      req.onsuccess = () => resolve()
      req.onerror = () => reject(req.error)
    })
  } catch (err) {
    log.warn('Failed to cache to IndexedDB', { layer, err })
  }
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Load a Natural Earth GeoJSON layer.
 * Returns cached data instantly when available; fetches from /geo/ on first use.
 */
export async function loadGeoLayer(layer: GeoLayerName): Promise<GeoJSONFeatureCollection> {
  // Tier 1: In-memory
  const cached = memoryCache.get(layer)
  if (cached) {
    log.debug(`${layer}: in-memory cache hit`, { features: cached.features.length })
    return cached
  }

  // Tier 2: IndexedDB
  const idbData = await getFromIDB(layer)
  if (idbData) {
    log.info(`${layer}: IndexedDB cache hit`, { features: idbData.features.length })
    memoryCache.set(layer, idbData)
    return idbData
  }

  // Tier 3: Fetch from /public/geo/
  log.info(`${layer}: fetching from /geo/${layer}.json ...`)
  const t0 = performance.now()

  const res = await fetch(`/geo/${layer}.json`)
  if (!res.ok) {
    throw new Error(`Failed to fetch /geo/${layer}.json: ${res.status}`)
  }

  const data = await res.json() as GeoJSONFeatureCollection
  const elapsed = (performance.now() - t0).toFixed(0)
  log.info(`${layer}: fetched`, { features: data.features.length, ms: elapsed })

  // Cache in both tiers
  memoryCache.set(layer, data)
  putToIDB(layer, data).catch(() => {}) // fire-and-forget

  return data
}

/**
 * Preload all three layers in parallel.
 * Call this early to warm the cache.
 */
export async function preloadAllGeoLayers(): Promise<void> {
  await Promise.all([
    loadGeoLayer('rivers'),
    loadGeoLayer('lakes'),
    loadGeoLayer('glaciers'),
  ])
}
